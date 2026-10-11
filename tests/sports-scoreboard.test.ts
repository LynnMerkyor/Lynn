import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSportsScoreboardEvidence } from "../shared/sports-scoreboard.js";

afterEach(() => vi.unstubAllGlobals());

function scoreboardEvent(id: string, date: string) {
  return {
    id,
    date,
    status: { type: { completed: true, shortDetail: "Final" } },
    competitions: [{ competitors: [
      { homeAway: "home", score: "110", team: { displayName: "Alpha" } },
      { homeAway: "away", score: "104", team: { displayName: "Beta" } },
    ] }],
  };
}

describe("model-directed sports scoreboard queries", () => {
  it("requires model dates without extracting them from a complete question", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSportsScoreboardEvidence("2026年7月19日世界杯决赛比分", { league: "fifa.world" })).rejects.toThrow("missing_date_range");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let question wording override supplied dates or filter teams and unfinished games", async () => {
    const scheduled = scoreboardEvent("scheduled", "2026-06-12T03:00:00Z");
    scheduled.status.type.completed = false;
    scheduled.status.type.shortDetail = "Scheduled";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ events: [scoreboardEvent("final", "2026-06-12T02:00:00Z"), scheduled] }) })));
    const result = await fetchSportsScoreboardEvidence("昨天英格兰总决赛比分", {
      league: "nba", date_from: "2026-06-12", date_to: "2026-06-12",
    });
    expect(result?.events).toBe(2);
    expect(result?.text).toContain("Alpha 110-104 Beta");
    expect(result?.text).toContain("Alpha vs Beta");
    expect(result?.text).not.toContain("teams: England");
    expect(result?.dateRange).toBe("20260612-20260612");
  });

  it("does not silently discard early games in a model-selected full date window", async () => {
    const events = Array.from({ length: 30 }, (_, index) => scoreboardEvent(String(index), "2026-06-12T02:00:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ events }) })));
    const result = await fetchSportsScoreboardEvidence("整轮比赛", { league: "nba", date_from: "2026-06-12" });
    expect(result?.evidence).toHaveLength(30);
    expect(result?.text).toContain("matched: 30");
  });

  it("uses model dates for a historical final rather than the current week", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ events: [scoreboardEvent("final", "2026-06-12T02:00:00Z")] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSportsScoreboardEvidence("NBA 总决赛打了几场，总比分如何？", {
      league: "nba", date_from: "2026-06-01", date_to: "2026-06-30", teams: ["Alpha"],
    });
    expect(fetchMock.mock.calls[0][0]).toContain("dates=20260531-20260701");
    expect(result?.text).toContain("Alpha 110-104 Beta");
    expect(result?.dateRange).toBe("20260601-20260630");
  });

  it("verifies an empty window through daily requests when the source rejects ranges", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: !new URL(url).searchParams.get("dates")?.includes("-"),
      status: 400,
      json: async () => ({ events: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSportsScoreboardEvidence("昨晚世界杯最新的比赛结果", {
      league: "fifa.world", date_from: "2026-10-08", date_to: "2026-10-09",
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result?.text).toContain("directSourceStatus: ok");
    expect(result?.text).toContain("matched: 0");
    expect(result?.text).toContain("dates=20261007");
    expect(result?.text).toContain("dates=20261010");
    expect(result?.text).not.toContain("fallback_static_schedule");
  });

  it("deduplicates events returned by adjacent daily pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: !new URL(url).searchParams.get("dates")?.includes("-"), status: 400,
      json: async () => ({ events: [scoreboardEvent("same", "2026-06-12T02:00:00Z")] }),
    })));
    const result = await fetchSportsScoreboardEvidence("赛果", { league: "nba", date_from: "2026-06-12" });
    expect(result?.events).toBe(1);
    expect(result?.evidence).toHaveLength(1);
  });

  it("keeps the model's full 31-day window including both timezone buffers", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: !new URL(url).searchParams.get("dates")?.includes("-"), status: 400,
      json: async () => ({ events: [scoreboardEvent("first-game", "2026-01-01T02:00:00Z")] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSportsScoreboardEvidence("整月比赛结果", {
      league: "nba", date_from: "2026-01-01", date_to: "2026-01-31",
    });
    expect(fetchMock).toHaveBeenCalledTimes(34);
    expect(result?.dateRange).toBe("20260101-20260131");
    expect(result?.events).toBe(1);
    expect(result?.text).toContain("dates=20251231");
    expect(result?.text).toContain("dates=20260201");
  });

  it("bounds daily fallback work beyond a full month", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSportsScoreboardEvidence("赛果", {
      league: "nba", date_from: "2026-01-01", date_to: "2026-02-01",
    })).rejects.toThrow("at most 31 days");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not turn a failed daily request into zero matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: false, status: new URL(url).searchParams.get("dates")?.includes("-") ? 400 : 403,
      json: async () => ({ events: [] }),
    })));
    await expect(fetchSportsScoreboardEvidence("昨晚赛果", { league: "fifa.world", date_from: "2026-10-08" })).rejects.toThrow("HTTP 403");
  });

  it("rejects invalid dates before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSportsScoreboardEvidence("赛果", { league: "nba", date_from: "2026-02-30" })).rejects.toThrow("invalid_date_range");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept a malformed successful response as an empty scoreboard", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ error: "upstream schema changed" }) })));
    await expect(fetchSportsScoreboardEvidence("赛果", { league: "nba", date_from: "2026-06-12" })).rejects.toThrow("invalid events payload");
  });
});
