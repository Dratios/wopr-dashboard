/**
 * Liaison temps réel avec le serveur.
 *
 * Remplace l'ancien `realBackendBridge.ts`, qui interrogeait quatre points d'API
 * toutes les 1,5 s. On utilise désormais le WebSocket `/ws/telemetry`, qui existait
 * déjà côté serveur mais que personne n'appelait.
 *
 * En cas de coupure, reconnexion automatique avec un délai croissant, et le store
 * bascule en « données figées » — l'interface le dit, plutôt que de continuer à
 * afficher les derniers chiffres comme s'ils étaient actuels.
 */

import { api } from './api';
import { store } from './store';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 20_000;
/** Tranches qui changent peu : rafraîchies par sondage, pas par le flux. */
const SLOW_REFRESH_MS = 30_000;
/** La liste des processus change vite : rafraîchie plus souvent. */
export const PROCESS_REFRESH_MS = 10_000;

let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: number | null = null;
let slowTimer: number | null = null;
let stopped = false;

/** Première photographie : on attend tout avant d'afficher quoi que ce soit. */
async function fetchInitialSnapshot(): Promise<void> {
  const [overview, cpuRam, gpu, thermal, storageNetwork, docker, processes, system, modes] =
    await Promise.all([
      api.overview(), api.cpuRam(), api.gpu(), api.thermal(),
      api.storageNetwork(), api.docker(), api.processes(), api.system(), api.modes(),
    ]);

  store.applySnapshot({
    overview, cpuRam, gpu, thermal, storageNetwork, docker, processes, system, modes,
  });
  store.markReady();
}

function connectSocket(): void {
  if (stopped) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/ws/telemetry`);

  socket.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    store.setConnected(true);
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type !== 'tick') return;
      store.applySnapshot({
        cpuRam: payload.cpuRam,
        gpu: payload.gpu,
        thermal: payload.thermal,
        docker: payload.docker,
        storageNetwork: payload.storageNetwork,
        // Vue d'ensemble complète : tuiles, santé, uptime, charge, conso, alertes,
        // mode actif et historique. Seuls les alertes et le mode étaient
        // transmis autrefois — le reste restait figé au chargement de la page.
        overview: payload.overview,
      });
    } catch {
      /* trame illisible : on ignore, la suivante arrive dans 2 s */
    }
  };

  socket.onclose = (event) => {
    store.setConnected(false);
    socket = null;

    // 4401 : le serveur a refusé la session. Inutile d'insister — le store a
    // déjà ramené l'utilisateur à l'écran de connexion.
    if (event.code === 4401) {
      stopped = true;
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = () => socket?.close();
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connectSocket();
  }, reconnectDelay);
}

/** Tranches hors du flux, pour ne pas l'alourdir : processus, système, modes. */
function startSlowPolling(): void {
  let elapsed = 0;
  const tick = async () => {
    if (stopped) return;
    elapsed += PROCESS_REFRESH_MS;
    const withSlow = elapsed >= SLOW_REFRESH_MS;
    if (withSlow) elapsed = 0;
    try {
      if (withSlow) {
        const [processes, system, modes] = await Promise.all([
          api.processes(), api.system(), api.modes(),
        ]);
        store.applySnapshot({ processes, system, modes });
      } else {
        store.applySnapshot({ processes: await api.processes() });
      }
    } catch {
      /* transitoire : la prochaine passe réessaiera */
    }
  };
  slowTimer = window.setInterval(tick, PROCESS_REFRESH_MS);
}

export async function startLiveConnection(): Promise<void> {
  stopped = false;
  reconnectDelay = RECONNECT_MIN_MS;
  await fetchInitialSnapshot();
  connectSocket();
  startSlowPolling();
}

export function stopLiveConnection(): void {
  stopped = true;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (slowTimer !== null) {
    window.clearInterval(slowTimer);
    slowTimer = null;
  }
  socket?.close();
  socket = null;
  store.setConnected(false);
}
