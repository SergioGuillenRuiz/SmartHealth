import { buildGraph, type Graph } from '../../domain/nav/graph';
import { buildMapIndex, type MapIndex } from '../../domain/nav/map-index';
import { PackError, readPack, type MapPack } from '../../domain/nav/pack';
import { buildSearchIndex, type SearchIndex } from '../../domain/nav/search';
import type { Box } from '../../domain/nav/zones';

// Abrir un paquete de mapa (los arrays tipados sobre el buffer, el grafo de calles, el índice para dibujar y el de búsqueda). De dónde sale el paquete lo decide `zone-manager.ts` (la zona
// guardada en el móvil o la que se acaba de bajar); en la demostración es una ciudad de mentira.

export interface NavData {
  pack: MapPack;
  graph: Graph;
  index: MapIndex;
  search: SearchIndex;
  title: string;
  /** El cuadrado que se pidió para esta zona (el que decide si una posición sigue dentro), y su identificador si es una zona guardada. */
  box: Box;
  zoneId: string | null;
}

export type NavLoad = { ok: true; data: NavData } | { ok: false; reason: 'offline' | 'busy' | 'failed' | 'empty' | 'broken' | 'paused'; message: string };

/** Abre un paquete. Lanza `PackError` si está estropeado o es de otra versión (el gestor lo borra y vuelve a bajarlo). */
export function openPack(buffer: ArrayBuffer, options: { title?: string; box?: Box; zoneId?: string | null } = {}): NavData {
  const pack = readPack(buffer);
  const { bbox } = pack.meta;
  return { pack, graph: buildGraph(pack), index: buildMapIndex(pack), search: buildSearchIndex(pack), title: options.title ?? pack.meta.name, box: options.box ?? bbox, zoneId: options.zoneId ?? null };
}

/** La ciudad de prueba de la demostración, como si fuera una zona. */
export async function loadSyntheticCity(): Promise<NavLoad> {
  const { buildSyntheticCity } = await import('../../domain/nav/synthetic-city');
  const { writePack } = await import('../../domain/nav/pack');
  try {
    return { ok: true, data: openPack(writePack(buildSyntheticCity().input), { title: 'Ciudad de prueba' }) };
  } catch (error) {
    if (error instanceof PackError) return { ok: false, reason: 'broken', message: `El mapa está estropeado: ${error.message}` };
    throw error;
  }
}
