import type {
  MediaItem,
  PhotoWallData,
  PhotoWallItem,
  PhotoWallQuery,
  Place,
  PlaceDetail,
  ProvinceLightData,
  CityLightData,
  StatsCityRow,
  StatsData,
  StatsDistanceRow,
  StatsPlaceRow,
  StatsProvinceRow,
  StatsQuery,
  StatsSeries,
  StatsTimePoint,
  Visit,
} from '../lib/types';
import type { ShareManifest, SharePlace, ShareVisit } from './api';
import { mediaUrl } from './api';
import { foldMunicipalityCity } from '../map/provinces';

/**
 * 2026-11-15 D-423：分享页复用正式版前端。
 * 把 manifest 适配成正式版现在用的数据形状（Place / PlaceDetail / Stats / PhotoWall），
 * 让同一个 App 组件以只读身份直接渲染，界面与交互和正式版完全一致。
 */

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface ShareSource {
  token: string;
  manifest: ShareManifest;
  expiresAt: number | null;
  displayName: string;
  places: Place[];
  details: Map<string, PlaceDetail>;
  companions: string[];
  timeline: { first: string | null; last: string | null; dates: string[] };
  mediaById: Map<string, { place: SharePlace; visit: ShareVisit; file: string; w: number; h: number; takenAt: number; bytes: number }>;
  thumbUrl(id: string): string;
  stats(q: StatsQuery): StatsData;
  provinceLight(): ProvinceLightData;
  /** 2026-11-16 D-490：统计模式热力图按城市点亮（manifest 只有城市名，按名字聚合） */
  cityLight(): CityLightData;
  photos(q: PhotoWallQuery): PhotoWallData;
}

export function buildShareSource(token: string, manifest: ShareManifest, expiresAt: number | null): ShareSource {
  const mediaById = new Map<
    string,
    { place: SharePlace; visit: ShareVisit; file: string; w: number; h: number; takenAt: number; bytes: number }
  >();
  const mediaList = new Map(manifest.media.map((m) => [m.id, m]));

  const details = new Map<string, PlaceDetail>();
  const places: Place[] = [];

  for (const p of manifest.places) {
    const visits: Visit[] = p.visits.map((v) => {
      const media: MediaItem[] = v.media
        .map((id) => mediaList.get(id))
        .filter(Boolean)
        .map((m) => {
          const mm = m!;
          mediaById.set(mm.id, {
            place: p,
            visit: v,
            file: mm.file,
            w: mm.w,
            h: mm.h,
            takenAt: mm.takenAt,
            bytes: mm.bytes,
          });
          return {
            id: mm.id,
            kind: 'photo' as const,
            width: mm.w,
            height: mm.h,
            duration: null,
            created_at: mm.takenAt,
          };
        });
      return {
        id: v.id,
        place_id: p.id,
        date: v.date,
        title: v.title ?? null,
        note: v.note ?? null,
        rating: null,
        companions: v.companions ?? null,
        media,
      };
    });
    const dates = visits.map((v) => v.date).filter(Boolean).sort();
    const photos = visits.reduce((n, v) => n + v.media.filter((m) => m.kind === 'photo').length, 0);
    const base: Place = {
      id: p.id,
      name: p.name,
      lng: p.lng,
      lat: p.lat,
      province: p.provinceName ?? null,
      city: p.city ?? null,
      county: p.district ?? null,
      province_code: p.provinceCode ?? null,
      city_code: null,
      county_code: null,
      kind: p.kind,
      secret: 0,
      home: p.home ? 1 : 0,
      cover_id: p.coverId ?? null,
      photos,
      videos: 0,
      visit_count: visits.length,
      first_date: dates[0] ?? null,
      last_date: dates[dates.length - 1] ?? null,
      total_visit_count: visits.length,
      total_first_date: dates[0] ?? null,
      total_last_date: dates[dates.length - 1] ?? null,
      created_at: manifest.createdAt,
    };
    places.push(base);
    details.set(p.id, { ...base, visits });
  }

  const companions = Array.from(
    new Set(manifest.places.flatMap((p) => p.visits.flatMap((v) => v.companions ?? [])))
  ).sort();

  const allVisits = manifest.places.flatMap((p) =>
    p.visits.map((v) => ({
      place: p,
      visit: v,
      photos: v.media.filter((id) => mediaList.has(id)).length,
    }))
  );
  const allDates = allVisits.map((v) => v.visit.date).filter(Boolean).sort();
  const timeline = {
    first: allDates[0] ?? null,
    last: allDates[allDates.length - 1] ?? null,
    dates: allDates,
  };

  const inRange = (date: string, from?: string | null, to?: string | null) =>
    (!from || date >= from) && (!to || date <= to);

  const matchQuery = (q: StatsQuery) => {
    const rows = allVisits.filter((v) => {
      if (!inRange(v.visit.date, q.from, q.to)) return false;
      if (q.province && (v.place.provinceName ?? '') !== q.province) return false;
      if (q.city && (v.place.city ?? '') !== q.city) return false;
      return true;
    });
    return rows;
  };

  const bucketOf = (date: string, bucket: 'year' | 'quarter' | 'month') => {
    const [y, m] = date.split('-');
    if (bucket === 'year') return y;
    const mi = Number(m);
    if (bucket === 'quarter') return `${y}-Q${Math.floor((mi - 1) / 3) + 1}`;
    return `${y}-${m}`;
  };

  const stats = (q: StatsQuery): StatsData => {
    const rows = matchQuery(q);
    const placeIds = new Set(rows.map((r) => r.place.id));
    const withPhotos = rows.filter((r) => r.photos > 0);
    const photos = rows.reduce((n, r) => n + r.photos, 0);
    const provinces = new Map<string, { visits: number; places: Set<string>; photos: number; first: string; last: string }>();
    const cities = new Map<string, { province: string; visits: number; places: Set<string>; photos: number; first: string; last: string }>();
    for (const r of rows) {
      const pn = r.place.provinceName ?? '';
      const cn = r.place.city ?? '';
      const p = provinces.get(pn) ?? { visits: 0, places: new Set(), photos: 0, first: r.visit.date, last: r.visit.date };
      p.visits += 1;
      p.places.add(r.place.id);
      p.photos += r.photos;
      if (r.visit.date < p.first) p.first = r.visit.date;
      if (r.visit.date > p.last) p.last = r.visit.date;
      provinces.set(pn, p);
      const key = `${pn}/${cn}`;
      const c = cities.get(key) ?? { province: pn, visits: 0, places: new Set(), photos: 0, first: r.visit.date, last: r.visit.date };
      c.visits += 1;
      c.places.add(r.place.id);
      c.photos += r.photos;
      if (r.visit.date < c.first) c.first = r.visit.date;
      if (r.visit.date > c.last) c.last = r.visit.date;
      cities.set(key, c);
    }

    const sortedVisits = [...rows].sort((a, b) => a.visit.date.localeCompare(b.visit.date));
    const firstRow = sortedVisits[0];
    const lastRow = sortedVisits[sortedVisits.length - 1];
    const firstPlace = firstRow
      ? {
          date: firstRow.visit.date,
          place_id: firstRow.place.id,
          place_name: firstRow.place.name,
          province: firstRow.place.provinceName ?? null,
          city: firstRow.place.city ?? null,
          lng: firstRow.place.lng,
          lat: firstRow.place.lat,
        }
      : null;
    const lastPlace = lastRow
      ? {
          date: lastRow.visit.date,
          place_id: lastRow.place.id,
          place_name: lastRow.place.name,
          province: lastRow.place.provinceName ?? null,
          city: lastRow.place.city ?? null,
          lng: lastRow.place.lng,
          lat: lastRow.place.lat,
        }
      : null;

    const homePlace = manifest.places.find((p) => p.home);
    const distanceRows: StatsDistanceRow[] = manifest.places
      .filter((p) => p.homeDistanceKm != null && p.id !== homePlace?.id && (!q.province || (p.provinceName ?? '') === q.province))
      .map((p) => {
        const own = allVisits.filter((v) => v.place.id === p.id);
        const dates = own.map((v) => v.visit.date).sort();
        return {
          id: p.id,
          name: p.name,
          province: p.provinceName ?? null,
          city: p.city ?? null,
          secret: 0,
          visits: own.length,
          photos: own.reduce((n, v) => n + v.photos, 0),
          videos: 0,
          first_date: dates[0] ?? null,
          last_date: dates[dates.length - 1] ?? null,
          distance_km: round1(Number(p.homeDistanceKm)),
        };
      })
      .sort((a, b) => b.distance_km - a.distance_km);

    const bucket = q.bucket ?? 'month';
    const timeMap = new Map<string, StatsTimePoint>();
    for (const r of rows) {
      const b = bucketOf(r.visit.date, bucket);
      const point =
        timeMap.get(b) ??
        ({
          bucket: b,
          label: bucket === 'year' ? b : bucket === 'quarter' ? `${b.slice(0, 4)} Q${b.slice(-1)}` : b.replace('-', '.'),
          visits: 0,
          places: 0,
          first_visits: 0,
          photos: 0,
          videos: 0,
        } as StatsTimePoint);
      point.visits += 1;
      point.places += 0;
      point.photos += r.photos;
      timeMap.set(b, point);
    }
    const time = [...timeMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
    for (const p of time) {
      p.places = new Set(rows.filter((r) => bucketOf(r.visit.date, bucket) === p.bucket).map((r) => r.place.id)).size;
      p.first_visits = p.places;
    }

    const seriesBy = q.seriesBy ?? null;
    const series: StatsSeries[] = [];
    if (seriesBy) {
      const groups = new Map<string, StatsSeries['points']>();
      for (const r of rows) {
        const name =
          seriesBy === 'city' ? r.place.city ?? '' : r.place.provinceName ?? '';
        const b = bucketOf(r.visit.date, bucket);
        const points = groups.get(name) ?? [];
        const found = points.find((x) => x.bucket === b);
        if (found) found.visits += 1;
        else points.push({ bucket: b, visits: 1, places: 1 });
        groups.set(name, points);
      }
      for (const [name, points] of groups) {
        if (series.length >= 6) break;
        series.push({ name, points: points.sort((a, b) => a.bucket.localeCompare(b.bucket)) });
      }
    }

    const provinceRows: StatsProvinceRow[] = [...provinces.entries()].map(([name, v]) => ({
      name,
      code: null,
      places: v.places.size,
      visits: v.visits,
      photos: v.photos,
      videos: 0,
      first_date: v.first,
      last_date: v.last,
    }));
    const cityRows: StatsCityRow[] = [...cities.entries()].map(([key, v]) => ({
      name: key.split('/')[1],
      province: v.province,
      places: v.places.size,
      visits: v.visits,
      photos: v.photos,
      videos: 0,
      first_date: v.first,
      last_date: v.last,
    }));
    const placeRows: StatsPlaceRow[] = manifest.places
      .filter((p) => placeIds.has(p.id) || (!rows.length && p.kind === 'visited'))
      .map((p) => {
        const own = allVisits.filter((v) => v.place.id === p.id);
        const dates = own.map((v) => v.visit.date).sort();
        return {
          id: p.id,
          name: p.name,
          province: p.provinceName ?? null,
          city: p.city ?? null,
          secret: 0,
          visits: own.length,
          photos: own.reduce((n, v) => n + v.photos, 0),
          videos: 0,
          first_date: dates[0] ?? null,
          last_date: dates[dates.length - 1] ?? null,
        };
      });

    return {
      range: { from: q.from ?? null, to: q.to ?? null, province: q.province ?? null, city: q.city ?? null },
      totals: {
        provinces: provinces.size,
        cities: cities.size,
        places: placeIds.size,
        visits: rows.length,
        photos,
        videos: 0,
      },
      first: firstPlace,
      last: lastPlace,
      farthest: distanceRows[0]
        ? {
            distance_km: distanceRows[0].distance_km,
            place_id: distanceRows[0].id,
            name: distanceRows[0].name,
            province: distanceRows[0].province ?? null,
            city: distanceRows[0].city ?? null,
            lng: manifest.places.find((p) => p.id === distanceRows[0].id)?.lng ?? 0,
            lat: manifest.places.find((p) => p.id === distanceRows[0].id)?.lat ?? 0,
          }
        : null,
      home: homePlace ? { id: homePlace.id, name: homePlace.name } : null,
      distance_places: distanceRows,
      distance_total: distanceRows.length,
      time,
      series,
      provinces: provinceRows,
      cities: cityRows,
      places: placeRows,
      ...(withPhotos.length ? {} : {}),
    };
  };

  const provinceLight = (): ProvinceLightData => {
    const map = new Map<string, { places: number; visits: number; first: string; last: string }>();
    for (const p of manifest.places) {
      const name = p.provinceName ?? '';
      const visits = p.visits.length;
      const dates = p.visits.map((v) => v.date).filter(Boolean).sort();
      const cur = map.get(name) ?? { places: 0, visits: 0, first: dates[0] ?? '', last: dates[dates.length - 1] ?? '' };
      cur.places += 1;
      cur.visits += visits;
      if (dates[0] && (!cur.first || dates[0] < cur.first)) cur.first = dates[0];
      if (dates.length && (!cur.last || dates[dates.length - 1] > cur.last)) cur.last = dates[dates.length - 1];
      map.set(name, cur);
    }
    const provinces = [...map.entries()].map(([name, v]) => ({
      name,
      code: null,
      places: v.places,
      visits: v.visits,
      first_date: v.first || null,
      last_date: v.last || null,
    }));
    return {
      provinces,
      maxPlaces: Math.max(1, ...provinces.map((p) => p.places)),
      maxVisits: Math.max(1, ...provinces.map((p) => p.visits)),
    };
  };

  /**
   * 2026-11-16 D-490：分享页的统计模式热力图也按城市点亮。
   * manifest 里只有城市**名字**（没有 city_code），所以这里只按名字聚合，
   * 前端匹配边界时是「先代码后名字」，对不上代码就会落到名字上。
   * 2026-11-17 D-516：直辖市 / 港澳的「区」折回整块（与 server/stats.mjs 的 cityLight 同规则），
   * 否则北京 / 香港这些按区存的老分享包整块不亮。
   */
  const cityLight = (): CityLightData => {
    const map = new Map<string, { places: number; visits: number; first: string; last: string; province: string }>();
    for (const p of manifest.places) {
      const name = foldMunicipalityCity(p.provinceName, p.city);
      if (!name) continue;
      const dates = p.visits.map((v) => v.date).filter(Boolean).sort();
      const cur = map.get(name) ?? {
        places: 0,
        visits: 0,
        first: dates[0] ?? '',
        last: dates[dates.length - 1] ?? '',
        province: p.provinceName ?? '',
      };
      cur.places += 1;
      cur.visits += p.visits.length;
      if (dates[0] && (!cur.first || dates[0] < cur.first)) cur.first = dates[0];
      if (dates.length && (!cur.last || dates[dates.length - 1] > cur.last)) cur.last = dates[dates.length - 1];
      map.set(name, cur);
    }
    const cities = [...map.entries()].map(([name, v]) => ({
      name,
      code: null,
      province: v.province || null,
      places: v.places,
      visits: v.visits,
      first_date: v.first || null,
      last_date: v.last || null,
    }));
    return {
      cities,
      maxPlaces: Math.max(1, ...cities.map((c) => c.places)),
      maxVisits: Math.max(1, ...cities.map((c) => c.visits)),
    };
  };

  const photos = (q: PhotoWallQuery): PhotoWallData => {
    const items: (PhotoWallItem & { placeId: string; province: string })[] = [];    for (const p of manifest.places) {
      for (const v of p.visits) {
        for (const id of v.media) {
          const m = mediaList.get(id);
          if (!m) continue;
          if (q.from && v.date < q.from) continue;
          if (q.to && v.date > q.to) continue;
          if (q.province && (p.provinceName ?? '') !== q.province) continue;
          if (q.city && (p.city ?? '') !== q.city) continue;
          if (q.place_id && p.id !== q.place_id) continue;
          items.push({
            id: m.id,
            kind: 'photo',
            width: m.w,
            height: m.h,
            duration: null,
            bytes: m.bytes,
            created_at: m.takenAt,
            date: v.date,
            visit_id: v.id,
            visit_title: v.title ?? null,
            place: {
              id: p.id,
              name: p.name,
              province: p.provinceName ?? null,
              city: p.city ?? null,
              county: p.district ?? null,
            },
            placeId: p.id,
            province: p.provinceName ?? '',
          } as PhotoWallItem & { placeId: string; province: string });
        }
      }
    }
    items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created_at - a.created_at);
    const yearMap = new Map<string, number>();
    for (const it of items) {
      const y = (it.date || '').slice(0, 4);
      if (y) yearMap.set(y, (yearMap.get(y) ?? 0) + 1);
    }
    const provinceMap = new Map<string, number>();
    for (const it of items) provinceMap.set(it.province, (provinceMap.get(it.province) ?? 0) + 1);
    const limit = Number((q as any).limit) || 60;
    const offset = Number((q as any).offset) || 0;
    return {
      total: items.length,
      items: items.slice(offset, offset + limit),
      years: [...yearMap.entries()].map(([year, count]) => ({ year, count })).sort((a, b) => b.year.localeCompare(a.year)),
      provinces: [...provinceMap.entries()].map(([name, count]) => ({ name, count })),
    };
  };

  return {
    token,
    manifest,
    expiresAt,
    displayName: manifest.sharer.displayName,
    places,
    details,
    companions,
    timeline,
    mediaById,
    thumbUrl: (id: string) => {
      const m = mediaById.get(id);
      return m ? mediaUrl(token, m.file) : '';
    },
    stats,
    provinceLight,
    cityLight,
    photos,
  };
}
