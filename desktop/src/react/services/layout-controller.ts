import { useStore } from '../stores';

const CHAT_MIN_WIDTH = 400;

function getCssPixelValue(property: string, fallback: number): number {
  return parseInt(getComputedStyle(document.documentElement).getPropertyValue(property)) || fallback;
}

function getSidebarWidth(): number {
  return getCssPixelValue('--sidebar-width', 240);
}

function getJianWidth(): number {
  return getCssPixelValue('--jian-sidebar-width', 260);
}

function getPreviewWidth(): number {
  return getCssPixelValue('--preview-panel-width', 580);
}

export function updateLayout(): void {
  const state = useStore.getState();
  const windowWidth = window.innerWidth;
  const leftWidth = state.sidebarOpen ? getSidebarWidth() : 0;
  const rightWidth = state.jianOpen ? getJianWidth() : 0;
  const previewWidth = state.previewOpen ? getPreviewWidth() : 0;
  const contentWidth = windowWidth - leftWidth - rightWidth - previewWidth;

  if (contentWidth < CHAT_MIN_WIDTH) {
    if (state.jianOpen) {
      useStore.setState({ jianOpen: false, jianAutoCollapsed: true });
      const contentWithoutDesk = windowWidth - (state.sidebarOpen ? getSidebarWidth() : 0) - previewWidth;
      if (contentWithoutDesk < CHAT_MIN_WIDTH && state.sidebarOpen) {
        useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
      }
    } else if (state.sidebarOpen) {
      useStore.setState({ sidebarOpen: false, sidebarAutoCollapsed: true });
    }
    return;
  }

  if (state.sidebarAutoCollapsed) {
    const canRestoreSidebar = windowWidth - rightWidth - previewWidth - getSidebarWidth() >= CHAT_MIN_WIDTH;
    const savedLeft = localStorage.getItem(`hana-sidebar-${state.currentTab || 'chat'}`);
    if (canRestoreSidebar && savedLeft !== 'closed') {
      useStore.setState({ sidebarOpen: true, sidebarAutoCollapsed: false });
    }
  }

  const updatedState = useStore.getState();
  if (updatedState.jianAutoCollapsed) {
    const restoredLeftWidth = updatedState.sidebarOpen ? getSidebarWidth() : 0;
    const canRestoreDesk = windowWidth - restoredLeftWidth - previewWidth - getJianWidth() >= CHAT_MIN_WIDTH;
    const savedRight = localStorage.getItem(`hana-jian-${updatedState.currentTab || 'chat'}`);
    if (canRestoreDesk && savedRight === 'open') {
      useStore.setState({ jianOpen: true, jianAutoCollapsed: false });
    }
  }
}

export function toggleSidebar(forceOpen?: boolean): void {
  const state = useStore.getState();
  const open = forceOpen ?? !state.sidebarOpen;
  useStore.setState({ sidebarOpen: open });
  localStorage.setItem(`hana-sidebar-${state.currentTab || 'chat'}`, open ? 'open' : 'closed');
  if (forceOpen === undefined) useStore.setState({ sidebarAutoCollapsed: false });
}
