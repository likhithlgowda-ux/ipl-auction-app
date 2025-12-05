"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ref, onValue } from "firebase/database";
import { db } from "../../../../lib/firebase";

type Team = {
  name: string;
  color: string;
  purseRemainingLakhs: number;
  playersBought?: Record<
    string,
    {
      name: string;
      priceLakhs: number;
    }
  >;
};

type RoomConfig = {
  season?: string;
  CF1?: number;
  CF2?: number;
  CF3?: number;
};

type RoomData = {
  teams?: Record<string, Team>;
  config?: RoomConfig;
};

type SeasonPlayer = {
  name: string;
  batting: {
    runs: number;
    avg: number;
    sr: number;
    fours: number;
    sixes: number;
  };
  bowling: {
    wickets: number;
    avg: number;
    econ: number;
    sr: number;
  };
};

type TeamLayout = {
  finalized?: boolean;
  slots: {
    BAT?: unknown;
    AR?: unknown;
    BOWL?: unknown;
  };
};

type TeamLayouts = Record<string, TeamLayout>;

type ScoredPlayer = SeasonPlayer & {
  id: string;
  battingScore: number;
  bowlingScore: number;
  allRounderScore: number;
};

type TeamScoreRow = {
  id: string;
  name: string;
  color: string;
  totalScore: number;
};

type PlayerBuyStat = {
  teamId: string;
  teamName: string;
  teamColor: string;
  playerId: string;
  playerName: string;
  priceLakhs: number;
  score: number;
  valuePerLakh: number;
};

function safeNum(n: unknown): number {
  if (n === null || n === undefined) return 0;
  const v = Number(n);
  return isNaN(v) ? 0 : v;
}

// Same normalization as in team-setup
function normalizeSlotList(raw: unknown): (string | null)[] {
  if (Array.isArray(raw)) {
    return raw as (string | null)[];
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return Object.keys(obj)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => (obj[k] as string | null | undefined) ?? null);
  }
  return [];
}

export default function LeaderboardPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();

  const routeParam = params.roomId;
  const rawId = Array.isArray(routeParam)
    ? routeParam[0]
    : String(routeParam);
  const isShortCode =
    rawId.length === 6 && /^[A-Za-z]+$/.test(rawId);
  const dbRoomId = isShortCode ? rawId.toLowerCase() : rawId;
  const displayRoomId = isShortCode ? rawId.toUpperCase() : rawId;

  const [room, setRoom] = useState<RoomData | null>(null);
  const [layouts, setLayouts] = useState<TeamLayouts>({});
  const [seasonPlayers, setSeasonPlayers] =
    useState<Record<string, SeasonPlayer>>({});
  const [loading, setLoading] = useState(true);

  // ----- subscribe to room + layouts -----
  useEffect(() => {
    if (!dbRoomId) return;
    const roomRef = ref(db, `rooms/${dbRoomId}`);
    const layoutRef = ref(db, `rooms/${dbRoomId}/teamLayout`);

    const unsubRoom = onValue(roomRef, (snap) => {
      setRoom((snap.val() as RoomData) || null);
      setLoading(false);
    });

    const unsubLayouts = onValue(layoutRef, (snap) => {
      setLayouts((snap.val() as TeamLayouts) || {});
    });

    return () => {
      unsubRoom();
      unsubLayouts();
    };
  }, [dbRoomId]);

  // ----- season players -----
  useEffect(() => {
    const season = room?.config?.season;
    if (!season) return;
    const spRef = ref(db, `seasons/${season}/players`);
    const unsub = onValue(spRef, (snap) => {
      setSeasonPlayers(
        (snap.val() as Record<string, SeasonPlayer>) || {}
      );
    });
    return () => unsub();
  }, [room?.config?.season]);

  const cfg: RoomConfig = room?.config || {};
  const teams = room?.teams || {};

  // ----- per-player scores -----
  const scoredPlayers: Record<string, ScoredPlayer> = useMemo(() => {
    const CF1 = safeNum(cfg.CF1 ?? 30);
    const CF2 = safeNum(cfg.CF2 ?? 2000);
    const CF3 = safeNum(cfg.CF3 ?? 1);

    const map: Record<string, ScoredPlayer> = {};
    Object.entries(seasonPlayers || {}).forEach(([id, p]) => {
      const bat = p.batting || ({} as SeasonPlayer["batting"]);
      const bowl = p.bowling || ({} as SeasonPlayer["bowling"]);

      const battingScore =
        safeNum(bat.runs) +
        safeNum(bat.sr) +
        safeNum(bat.avg) +
        safeNum(bat.fours) +
        safeNum(bat.sixes);

      const wickets = safeNum(bowl.wickets);
      const econ = safeNum(bowl.econ);
      const bowlingScore =
        CF1 * wickets + (econ > 0 ? CF2 / econ : 0);

      const allRounderScore = CF3 * (battingScore + bowlingScore);

      map[id] = {
        ...p,
        id,
        battingScore,
        bowlingScore,
        allRounderScore
      };
    });
    return map;
  }, [seasonPlayers, cfg.CF1, cfg.CF2, cfg.CF3]);

  // ----- team scores + buy stats -----
  const { teamRows, topSteals, topHighBuys } = useMemo(() => {
    const rows: TeamScoreRow[] = [];
    const buyStats: PlayerBuyStat[] = [];

    Object.entries(teams || {}).forEach(([teamId, team]) => {
      const layout = layouts[teamId];
      if (!layout || !layout.slots) return;

      const BAT = normalizeSlotList(layout.slots.BAT);
      const AR = normalizeSlotList(layout.slots.AR);
      const BOWL = normalizeSlotList(layout.slots.BOWL);

      const playerIds = [...BAT, ...AR, ...BOWL].filter(Boolean) as string[];

      let totalScore = 0;
      playerIds.forEach((pid) => {
        const sp = scoredPlayers[pid];
        if (!sp) return;
        totalScore += sp.allRounderScore;
      });

      rows.push({
        id: teamId,
        name: team.name,
        color: team.color,
        totalScore
      });

      if (team.playersBought) {
        Object.entries(team.playersBought).forEach(([pid, info]) => {
          const sp = scoredPlayers[pid];
          const score = sp?.allRounderScore ?? 0;
          const price = safeNum(info.priceLakhs);
          const valuePerLakh =
            price > 0 ? score / price : score;
          buyStats.push({
            teamId,
            teamName: team.name,
            teamColor: team.color,
            playerId: pid,
            playerName: info.name,
            priceLakhs: price,
            score,
            valuePerLakh
          });
        });
      }
    });

    rows.sort((a, b) => b.totalScore - a.totalScore);

    const steals = [...buyStats]
      .filter((b) => b.score > 0 && b.priceLakhs > 0)
      .sort((a, b) => b.valuePerLakh - a.valuePerLakh)
      .slice(0, 3);

    const highestBuys = [...buyStats]
      .sort((a, b) => b.priceLakhs - a.priceLakhs)
      .slice(0, 3);

    return { teamRows: rows, topSteals: steals, topHighBuys: highestBuys };
  }, [teams, layouts, scoredPlayers]);

  if (loading || !room) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black text-white flex items-center justify-center">
        <p className="text-sm text-gray-300">Loading leaderboard…</p>
      </main>
    );
  }

  if (!room.teams || Object.keys(room.teams).length === 0) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black text-white flex items-center justify-center">
        <p className="text-sm text-gray-300">
          No teams found for this room.
        </p>
      </main>
    );
  }

  const first = teamRows[0];
  const second = teamRows[1];
  const third = teamRows[2];

  return (
    <main className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black text-white px-4 py-6 md:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              Leaderboard –{" "}
              <span className="font-mono text-blue-400">
                {displayRoomId}
              </span>
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              Final standings and auction highlights for this room.
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Season:{" "}
              <span className="font-mono">
                {room.config?.season ?? "unknown"}
              </span>
            </p>
          </div>
          <button
            className="mt-1 md:mt-0 inline-flex items-center justify-center px-4 md:px-5 py-2 md:py-2.5 rounded-full bg-blue-600 hover:bg-blue-500 text-sm md:text-base font-semibold shadow-md"
            onClick={() => router.push(`/room/${displayRoomId}`)}
          >
            Back to auction home
          </button>
        </header>

        {/* Main leaderboard (podium + full table) */}
        {first && (
          <section className="rounded-2xl bg-white/5 backdrop-blur-md border border-white/10 shadow-xl p-4 md:p-6 flex flex-col gap-6">
            <div>
              <h2 className="text-lg md:text-xl font-semibold mb-2">
                Overall standings
              </h2>
              <p className="text-xs md:text-sm text-gray-400">
                Top three podium plus full ranking of all teams.
              </p>
            </div>

            {/* Podium a bit bigger */}
            <div className="bg-black/40 rounded-2xl border border-white/5 p-4 md:p-6">
              <h3 className="text-base md:text-lg font-semibold mb-4">
                Podium
              </h3>
              <div className="flex items-end justify-center gap-5 md:gap-10">
                {/* Second place */}
                {second && (
                  <div className="flex flex-col items-center text-xs md:text-sm">
                    <div
                      className="w-24 md:w-32 h-24 md:h-32 rounded-t-2xl flex items-center justify-center text-center font-semibold shadow-md"
                      style={{ backgroundColor: second.color }}
                    >
                      <span className="px-2 truncate">
                        {second.name}
                      </span>
                    </div>
                    <div className="w-24 md:w-32 h-10 md:h-11 bg-gray-900 flex items-center justify-center rounded-b-2xl border-t border-white/10">
                      <span className="text-gray-100">
                        2nd · {second.totalScore.toFixed(1)}
                      </span>
                    </div>
                  </div>
                )}

                {/* First place */}
                <div className="flex flex-col items-center text-sm md:text-base">
                  <div
                    className="w-28 md:w-40 h-28 md:h-40 rounded-t-2xl flex items-center justify-center text-center text-base md:text-xl font-bold shadow-lg shadow-yellow-500/40 border border-yellow-300/70"
                    style={{ backgroundColor: first.color }}
                  >
                    <span className="px-3 truncate">{first.name}</span>
                  </div>
                  <div className="w-28 md:w-40 h-11 md:h-12 bg-yellow-400 flex items-center justify-center rounded-b-2xl">
                    <span className="text-black font-semibold">
                      1st · {first.totalScore.toFixed(1)}
                    </span>
                  </div>
                </div>

                {/* Third place */}
                {third && (
                  <div className="flex flex-col items-center text-xs md:text-sm">
                    <div
                      className="w-24 md:w-32 h-24 md:h-32 rounded-t-2xl flex items-center justify-center text-center font-semibold shadow-md"
                      style={{ backgroundColor: third.color }}
                    >
                      <span className="px-2 truncate">
                        {third.name}
                      </span>
                    </div>
                    <div className="w-24 md:w-32 h-10 md:h-11 bg-gray-900 flex items-center justify-center rounded-b-2xl border-t border-white/10">
                      <span className="text-gray-100">
                        3rd · {third.totalScore.toFixed(1)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Full standings table, slightly larger */}
            <div className="bg-black/40 rounded-2xl border border-white/5 p-4 md:p-5">
              <h3 className="text-base md:text-lg font-semibold mb-3">
                All teams
              </h3>
              {teamRows.length === 0 ? (
                <p className="text-sm text-gray-400">
                  No finalized lineups yet.
                </p>
              ) : (
                <table className="w-full text-xs md:text-sm lg:text-base">
                  <thead className="text-left text-gray-300 border-b border-gray-700/70">
                    <tr>
                      <th className="py-2.5 pr-3 w-16">Rank</th>
                      <th className="py-2.5 pr-3">Team</th>
                      <th className="py-2.5 pr-3 text-right">
                        Total score
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamRows.map((row, index) => (
                      <tr
                        key={row.id}
                        className="border-b border-gray-800/70 last:border-b-0 hover:bg-white/5 transition-colors"
                      >
                        <td className="py-2.5 pr-3 font-semibold">
                          #{index + 1}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span
                            className="inline-flex items-center px-3 py-1 rounded-full text-xs md:text-sm font-semibold"
                            style={{ backgroundColor: row.color }}
                          >
                            {row.name}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 text-right font-medium">
                          {row.totalScore.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        )}

        {/* Stats: top steals + highest buys */}
        <section className="grid md:grid-cols-2 gap-4">
          <div className="rounded-2xl bg-white/5 backdrop-blur-md border border-white/10 shadow-lg p-4 md:p-5">
            <h2 className="text-lg font-semibold mb-3">
              Top steal buys
            </h2>
            {topSteals.length === 0 ? (
              <p className="text-xs md:text-sm text-gray-400">
                No scored players available yet.
              </p>
            ) : (
              <ul className="text-xs md:text-sm space-y-3">
                {topSteals.map((s, idx) => (
                  <li
                    key={`${s.teamId}-${s.playerId}`}
                    className="flex items-center justify-between"
                  >
                    <div className="flex flex-col">
                      <span className="font-semibold">
                        {s.playerName}
                      </span>
                      <span className="text-gray-400 text-xs md:text-sm">
                        {s.teamName} · Score {s.score.toFixed(1)} for{" "}
                        {(s.priceLakhs / 100).toFixed(2)} Cr
                      </span>
                    </div>
                    <span className="text-emerald-400 text-xs md:text-sm ml-3 whitespace-nowrap">
                      #{idx + 1} · {s.valuePerLakh.toFixed(2)} pts/L
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl bg-white/5 backdrop-blur-md border border-white/10 shadow-lg p-4 md:p-5">
            <h2 className="text-lg font-semibold mb-3">Biggest buys</h2>
            {topHighBuys.length === 0 ? (
              <p className="text-xs md:text-sm text-gray-400">
                No auction purchases recorded.
              </p>
            ) : (
              <ul className="text-xs md:text-sm space-y-3">
                {topHighBuys.map((s, idx) => (
                  <li
                    key={`${s.teamId}-${s.playerId}`}
                    className="flex items-center justify-between"
                  >
                    <div className="flex flex-col">
                      <span className="font-semibold">
                        {s.playerName}
                      </span>
                      <span className="text-gray-400 text-xs md:text-sm">
                        {s.teamName} ·{" "}
                        {(s.priceLakhs / 100).toFixed(2)} Cr
                      </span>
                    </div>
                    <span className="text-amber-400 text-xs md:text-sm ml-3 whitespace-nowrap">
                      #{idx + 1} · Score {s.score.toFixed(1)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
