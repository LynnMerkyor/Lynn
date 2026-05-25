/**
 * error-bus-bridge.ts — ErrorBus (shared) → Zustand toast store bridge
 *
 * Call initErrorBusBridge() once during app init to wire up the renderer-side
 * ErrorBus subscriber to the toast slice.
 */

import { errorBus } from '../../../../shared/error-bus.js';
import { useStore } from '../stores';
import type { ErrorRoute } from './types';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function initErrorBusBridge(): void {
  errorBus.subscribe((entry, route) => {
    const { error } = entry;
    const userMessage = error.message || t(error.userMessageKey) || error.code;
    const normalizedRoute: ErrorRoute = route === 'toast'
      || route === 'statusbar'
      || route === 'boundary'
      || route === 'silent'
      ? route
      : 'toast';

    switch (normalizedRoute) {
      case 'toast':
        useStore.getState().addToast(
          userMessage,
          error.severity === 'cosmetic' ? 'warning' : 'error',
          error.severity === 'critical' ? 0 : 5000,
          {
            errorCode: error.code,
            persistent: error.severity === 'critical',
            dedupeKey: error.code,
          }
        );
        break;
      case 'statusbar':
        // WebSocket manages its own wsState in connection-slice
        break;
      case 'boundary':
        // ErrorBoundary catches render errors directly
        break;
      case 'silent':
        // Log only (already logged by ErrorBus._log)
        break;
    }
  });
}
