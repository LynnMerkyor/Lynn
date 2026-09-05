import { hanaFetch } from '../hooks/use-hana-fetch';
import { useStore } from './index';

let selectionVersion = 0;

/** A history response belongs to one selection, not to the shared chat view. */
export async function openBridgeSession(sessionKey: string): Promise<void> {
  const version = ++selectionVersion;
  const isCurrent = () => version === selectionVersion && useStore.getState().activeBridgeSessionKey === sessionKey;
  useStore.setState({ activeBridgeSessionKey: sessionKey, activeBridgeMessages: [], bridgeHistoryLoading: true, bridgeHistoryError: null, welcomeVisible: false });
  try {
    const response = await hanaFetch(`/api/bridge/sessions/${encodeURIComponent(sessionKey)}/messages`);
    const data = await response.json();
    if (data.error) throw new Error(String(data.error));
    if (isCurrent()) useStore.setState({ activeBridgeMessages: data.messages || [], bridgeHistoryLoading: false });
  } catch (error) {
    if (isCurrent()) useStore.setState({ bridgeHistoryLoading: false, bridgeHistoryError: error instanceof Error ? error.message : String(error) });
  }
}
