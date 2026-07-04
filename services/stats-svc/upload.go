// Demo yükleme: kullanıcı .dem dosyasını tarayıcıdan yükler → SHA-256 +
// dedup → MinIO → demo.ingested (NATS). Parser/enrichment worker'ları
// gerisini otomatik halleder (§2 veri akışı). Üyelik/yetki katmanı yayına
// hazırlık fazında bu endpoint'in önüne eklenecek.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/nats-io/nats.go"
)

const maxDemoBytes = 2 << 30 // 2 GiB üst sınır

type uploader struct {
	mc     *minio.Client
	bucket string
	nc     *nats.Conn
}

func newUploader() (*uploader, error) {
	endpoint := os.Getenv("S3_ENDPOINT") // http://localhost:9100
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid S3_ENDPOINT: %q", endpoint)
	}
	mc, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(os.Getenv("MINIO_ROOT_USER"), os.Getenv("MINIO_ROOT_PASSWORD"), ""),
		Secure: u.Scheme == "https",
	})
	if err != nil {
		return nil, err
	}
	nc, err := nats.Connect(os.Getenv("NATS_URL"))
	if err != nil {
		return nil, err
	}
	return &uploader{mc: mc, bucket: os.Getenv("S3_BUCKET"), nc: nc}, nil
}

// POST /api/v1/upload — multipart: "demo" (dosya), opsiyonel "played_at" (ISO)
func (s *server) upload(w http.ResponseWriter, r *http.Request) {
	if s.up == nil {
		writeErr(w, 503, fmt.Errorf("upload infrastructure unavailable (MinIO/NATS connection)"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxDemoBytes)

	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, 400, fmt.Errorf("multipart form expected: %w", err))
		return
	}

	var (
		fileName string
		playedAt string
		tmpPath  string
		sha      string
		size     int64
	)
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeErr(w, 400, err)
			return
		}
		switch part.FormName() {
		case "played_at":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			playedAt = strings.TrimSpace(string(b))
		case "demo":
			fileName = part.FileName()
			if !strings.HasSuffix(strings.ToLower(fileName), ".dem") {
				writeErr(w, 400, fmt.Errorf("only .dem files are accepted"))
				return
			}
			// Akış halinde geçici dosyaya yaz + aynı anda SHA-256 hesapla
			tmp, err := os.CreateTemp("", "upload-*.dem")
			if err != nil {
				writeErr(w, 500, err)
				return
			}
			tmpPath = tmp.Name()
			h := sha256.New()
			size, err = io.Copy(io.MultiWriter(tmp, h), part)
			tmp.Close()
			if err != nil {
				os.Remove(tmpPath)
				writeErr(w, 400, fmt.Errorf("upload interrupted: %w", err))
				return
			}
			sha = hex.EncodeToString(h.Sum(nil))
		}
	}
	if tmpPath == "" {
		writeErr(w, 400, fmt.Errorf("\"demo\" alanı eksik"))
		return
	}
	defer os.Remove(tmpPath)

	resp, code, err := s.ingestLocalDemo(tmpPath, sha, size,
		strings.TrimSuffix(fileName, ".dem"), playedAt, "")
	if err != nil {
		writeErr(w, code, err)
		return
	}
	writeJSON(w, 200, resp)
}

// ingestLocalDemo: geçici .dem dosyasını boru hattına verir (dedup → MinIO →
// demo.ingested). Manuel upload ve FACEIT import bu tek yolu paylaşır.
func (s *server) ingestLocalDemo(
	tmpPath, sha string, size int64, sourceFile, playedAt, tournament string,
) (map[string]any, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Dedup: aynı demo daha önce işlendiyse doğrudan mevcut maça yönlendir
	var existingID uuid.UUID
	var existingStatus string
	err := s.pg.QueryRow(ctx,
		"SELECT match_id, status FROM matches WHERE demo_sha256 = $1", sha).
		Scan(&existingID, &existingStatus)
	if err == nil && existingStatus == "ready" {
		return map[string]any{
			"match_id": existingID, "demo_sha256": sha,
			"status": "ready", "duplicate": true,
		}, 200, nil
	}

	// MinIO'ya yükle
	objectKey := "raw/" + sha + ".dem"
	f, err := os.Open(tmpPath)
	if err != nil {
		return nil, 500, err
	}
	defer f.Close()
	if _, err := s.up.mc.PutObject(ctx, s.up.bucket, objectKey, f, size,
		minio.PutObjectOptions{ContentType: "application/octet-stream"}); err != nil {
		return nil, 500, fmt.Errorf("S3 upload failed: %w", err)
	}

	// demo.ingested yayınla — parser worker'ı devralır
	matchID := uuid.New()
	if existingID != uuid.Nil {
		matchID = existingID // yarım kalmış işleme: aynı maç kimliğiyle tekrar dene
	}
	payload, _ := json.Marshal(map[string]any{
		"demo_sha256": sha,
		"match_id":    matchID,
		"object_key":  objectKey,
		"source_file": sourceFile,
		"played_at":   playedAt,
		"tournament":  tournament,
	})
	if err := s.up.nc.Publish("demo.ingested", payload); err != nil {
		return nil, 500, fmt.Errorf("failed to enqueue: %w", err)
	}
	return map[string]any{
		"match_id": matchID, "demo_sha256": sha,
		"status": "queued", "size_bytes": size,
	}, 200, nil
}

// GET /api/v1/matches/{id}/status — yükleme sonrası ilerleme takibi
func (s *server) matchStatus(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid match_id"))
		return
	}
	var status string
	var mapName *string
	if err := s.pg.QueryRow(r.Context(),
		"SELECT status, map_name FROM matches WHERE match_id = $1", id).
		Scan(&status, &mapName); err != nil {
		// parser henüz satırı yazmadıysa kuyruğta demektir
		writeJSON(w, 200, map[string]any{"status": "queued"})
		return
	}
	writeJSON(w, 200, map[string]any{"status": status, "map_name": mapName})
}
