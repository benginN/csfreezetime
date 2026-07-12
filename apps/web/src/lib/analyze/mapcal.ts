// Radar kalibrasyonları — infra/postgres/schema.sql'deki seed'in TS kopyası.
// WASM Analyze tarayıcıda çalışırken sunucu yok; dönüşüm (replay.go:318):
//   rx = (x - pos_x) / scale ,  ry = (pos_y - y) / scale
// Yeni harita eklenirse İKİ yer birlikte güncellenir (schema.sql + burası).
import type { RadarCal } from '../../api';

export const MAP_CAL: Record<string, RadarCal & { pos_x: number; pos_y: number; scale: number }> = {
  de_ancient:  { pos_x: -2953, pos_y: 2164, scale: 5.0,   has_lower: false, split_z: null },
  de_anubis:   { pos_x: -2796, pos_y: 3328, scale: 5.22,  has_lower: false, split_z: null },
  de_dust2:    { pos_x: -2476, pos_y: 3239, scale: 4.4,   has_lower: false, split_z: null },
  de_inferno:  { pos_x: -2087, pos_y: 3870, scale: 4.9,   has_lower: false, split_z: null },
  de_mirage:   { pos_x: -3230, pos_y: 1713, scale: 5.0,   has_lower: false, split_z: null },
  de_nuke:     { pos_x: -3453, pos_y: 2887, scale: 7.0,   has_lower: true,  split_z: -495 },
  de_overpass: { pos_x: -4831, pos_y: 1781, scale: 5.2,   has_lower: false, split_z: null },
  de_train:    { pos_x: -2308, pos_y: 2078, scale: 4.082, has_lower: false, split_z: null },
  de_vertigo:  { pos_x: -3168, pos_y: 1762, scale: 4.0,   has_lower: true,  split_z: 11700 },
};
