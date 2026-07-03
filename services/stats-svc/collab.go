// İşbirliği araçları: playlist'ler (an koleksiyonları) ve zaman damgalı
// notlar (metin + opsiyonel ses, MinIO'da). Auth henüz yok — tek-org yerel
// kurulum; üyelik fazında owner kolonları eklenecek.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
)

// ---- Playlists ----

// GET /api/v1/playlists
func (s *server) playlistsList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"playlists": s.jsonQuery(r.Context(), `
		SELECT COALESCE(json_agg(x ORDER BY x.created_at DESC), '[]'::json) FROM (
		    SELECT p.playlist_id, p.name, p.created_at,
		           count(i.item_id) AS items
		    FROM playlists p
		    LEFT JOIN playlist_items i ON i.playlist_id = p.playlist_id
		    GROUP BY p.playlist_id
		) x`)})
}

// POST /api/v1/playlists {"name": "..."}
func (s *server) playlistCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		writeErr(w, 400, fmt.Errorf("name is required"))
		return
	}
	var id int
	if err := s.pg.QueryRow(r.Context(),
		"INSERT INTO playlists (name) VALUES ($1) RETURNING playlist_id",
		body.Name).Scan(&id); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"playlist_id": id, "name": body.Name})
}

// DELETE /api/v1/playlists/{id}
func (s *server) playlistDelete(w http.ResponseWriter, r *http.Request) {
	if _, err := s.pg.Exec(r.Context(),
		"DELETE FROM playlists WHERE playlist_id = $1", chi.URLParam(r, "id")); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// GET /api/v1/playlists/{id} — öğeler, maç etiketleriyle
func (s *server) playlistGet(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var name string
	if err := s.pg.QueryRow(r.Context(),
		"SELECT name FROM playlists WHERE playlist_id = $1", id).Scan(&name); err != nil {
		writeErr(w, 404, fmt.Errorf("playlist not found"))
		return
	}
	writeJSON(w, 200, map[string]any{
		"playlist_id": id, "name": name,
		"items": s.jsonQuery(r.Context(), `
		SELECT COALESCE(json_agg(x ORDER BY x.position, x.item_id), '[]'::json) FROM (
		    SELECT i.item_id, i.match_id, i.round_number, i.t_sec, i.note,
		           i.position, m.map_name,
		           ta.name AS team_a, tb.name AS team_b
		    FROM playlist_items i
		    JOIN matches m ON m.match_id = i.match_id
		    LEFT JOIN teams ta ON ta.team_id = m.team_a_id
		    LEFT JOIN teams tb ON tb.team_id = m.team_b_id
		    WHERE i.playlist_id = $1
		) x`, id),
	})
}

// POST /api/v1/playlists/{id}/items {match_id, round_number, t_sec?, note?}
func (s *server) playlistAddItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		MatchID     uuid.UUID `json:"match_id"`
		RoundNumber int16     `json:"round_number"`
		TSec        *float64  `json:"t_sec"`
		Note        string    `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, fmt.Errorf("could not parse JSON: %w", err))
		return
	}
	var itemID int
	err := s.pg.QueryRow(r.Context(), `
		INSERT INTO playlist_items (playlist_id, match_id, round_number, t_sec, note, position)
		VALUES ($1, $2, $3, $4, $5,
		        COALESCE((SELECT max(position)+1 FROM playlist_items WHERE playlist_id=$1), 0))
		RETURNING item_id`,
		id, body.MatchID, body.RoundNumber, body.TSec, body.Note).Scan(&itemID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"item_id": itemID})
}

// DELETE /api/v1/playlists/{id}/items/{item}
func (s *server) playlistDeleteItem(w http.ResponseWriter, r *http.Request) {
	if _, err := s.pg.Exec(r.Context(),
		"DELETE FROM playlist_items WHERE playlist_id = $1 AND item_id = $2",
		chi.URLParam(r, "id"), chi.URLParam(r, "item")); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---- Notes ----

// GET /api/v1/matches/{id}/notes
func (s *server) notesList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"notes": s.jsonQuery(r.Context(), `
		SELECT COALESCE(json_agg(x ORDER BY x.round_number, x.t_sec), '[]'::json) FROM (
		    SELECT note_id, round_number, t_sec, author, body,
		           (audio_key IS NOT NULL) AS has_audio, created_at
		    FROM notes WHERE match_id = $1
		) x`, chi.URLParam(r, "id"))})
}

// POST /api/v1/matches/{id}/notes — multipart: round_number, t_sec, body,
// author, audio (opsiyonel webm)
func (s *server) noteCreate(w http.ResponseWriter, r *http.Request) {
	matchID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, 400, fmt.Errorf("invalid match_id"))
		return
	}
	if err := r.ParseMultipartForm(16 << 20); err != nil { // ses ≤16MB
		writeErr(w, 400, fmt.Errorf("multipart form expected: %w", err))
		return
	}
	round, _ := strconv.Atoi(r.FormValue("round_number"))
	tsec, _ := strconv.ParseFloat(r.FormValue("t_sec"), 64)
	body := r.FormValue("body")
	author := r.FormValue("author")

	var noteID int
	if err := s.pg.QueryRow(r.Context(), `
		INSERT INTO notes (match_id, round_number, t_sec, author, body)
		VALUES ($1,$2,$3,$4,$5) RETURNING note_id`,
		matchID, round, tsec, author, body).Scan(&noteID); err != nil {
		writeErr(w, 500, err)
		return
	}

	if f, _, err := r.FormFile("audio"); err == nil {
		defer f.Close()
		if s.up == nil {
			writeErr(w, 503, fmt.Errorf("audio storage unavailable"))
			return
		}
		key := fmt.Sprintf("notes/%d.webm", noteID)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if _, err := s.up.mc.PutObject(ctx, s.up.bucket, key, f, -1,
			minio.PutObjectOptions{ContentType: "audio/webm"}); err != nil {
			writeErr(w, 500, fmt.Errorf("audio upload: %w", err))
			return
		}
		if _, err := s.pg.Exec(r.Context(),
			"UPDATE notes SET audio_key = $1 WHERE note_id = $2", key, noteID); err != nil {
			writeErr(w, 500, err)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"note_id": noteID})
}

// GET /api/v1/notes/{id}/audio — MinIO'dan akış
func (s *server) noteAudio(w http.ResponseWriter, r *http.Request) {
	var key *string
	if err := s.pg.QueryRow(r.Context(),
		"SELECT audio_key FROM notes WHERE note_id = $1",
		chi.URLParam(r, "id")).Scan(&key); err != nil || key == nil {
		writeErr(w, 404, fmt.Errorf("no audio for this note"))
		return
	}
	obj, err := s.up.mc.GetObject(r.Context(), s.up.bucket, *key, minio.GetObjectOptions{})
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer obj.Close()
	w.Header().Set("Content-Type", "audio/webm")
	io.Copy(w, obj)
}

// DELETE /api/v1/notes/{id}
func (s *server) noteDelete(w http.ResponseWriter, r *http.Request) {
	if _, err := s.pg.Exec(r.Context(),
		"DELETE FROM notes WHERE note_id = $1", chi.URLParam(r, "id")); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
