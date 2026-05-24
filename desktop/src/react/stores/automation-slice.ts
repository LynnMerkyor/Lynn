export interface AutomationSlice {
  /** Automation job count for badge */
  automationCount: number;
}

export const createAutomationSlice = (
  _set: (partial: Partial<AutomationSlice>) => void
): AutomationSlice => ({
  automationCount: 0,
});

// ── Selectors ──
export const selectAutomationCount = (s: AutomationSlice) => s.automationCount;
