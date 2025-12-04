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

      // build buy stats off playersBought
      if (team.playersBought) {
        Object.entries(team.playersBought).forEach(([pid, info]) => {
          const sp = scoredPlayers[pid];
          const score = sp?.allRounderScore ?? 0;
          const price = safeNum(info.priceLakhs);
          const valuePerLakh =
            price > 0 ? score / price : score; // arbitrary but useful
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
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>Loading leaderboard…</p>
      </main>
    );
  }

  if (!room.teams || Object.keys(room.teams).length === 0) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>No teams found for this room.</p>
      </main>
    );
  }

  const first = teamRows[0];
  const second = teamRows[1];
  const third = teamRows[2];

  return (
    <main className="min-h-screen bg-black text-white p-4 flex flex-col gap-4">
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">
            Leaderboard – Room {displayRoomId}
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Podium standings and auction highlights.
          </p>
        </div>
        <button
          className="text-sm text-blue-400 underline"
          onClick={() => router.push(`/room/${displayRoomId}/team-setup`)}
        >
          Back to team setup
        </button>
      </header>

      {/* Podium */}
      {first && (
        <section className="bg-gray-900 rounded p-4">
          <h2 className="text-lg font-semibold mb-3">Podium</h2>
          <div className="flex items-end justify-center gap-4 md:gap-8">
            {/* Second place - left */}
            {second && (
              <div className="flex flex-col items-center text-xs md:text-sm">
                <div
                  className="w-24 md:w-32 h-24 md:h-32 rounded-t-lg flex items-center justify-center text-center text-sm font-semibold"
                  style={{ backgroundColor: second.color }}
                >
                  <span className="px-1">{second.name}</span>
                </div>
                <div className="w-24 md:w-32 h-10 bg-gray-800 flex items-center justify-center rounded-b-lg">
                  <span className="text-gray-200">
                    2nd · {second.totalScore.toFixed(1)}
                  </span>
                </div>
              </div>
            )}

            {/* First place - center, bigger */}
            <div className="flex flex-col items-center text-sm md:text-base">
              <div
                className="w-32 md:w-40 h-32 md:h-40 rounded-t-lg flex items-center justify-center text-center text-base md:text-lg font-bold shadow-lg shadow-yellow-500/40 border border-yellow-300/60"
                style={{ backgroundColor: first.color }}
              >
                <span className="px-2">{first.name}</span>
              </div>
              <div className="w-32 md:w-40 h-12 bg-yellow-500 flex items-center justify-center rounded-b-lg">
                <span className="text-black font-semibold">
                  1st · {first.totalScore.toFixed(1)}
                </span>
              </div>
            </div>

            {/* Third place - right */}
            {third && (
              <div className="flex flex-col items-center text-xs md:text-sm">
                <div
                  className="w-24 md:w-32 h-24 md:h-32 rounded-t-lg flex items-center justify-center text-center text-sm font-semibold"
                  style={{ backgroundColor: third.color }}
                >
                  <span className="px-1">{third.name}</span>
                </div>
                <div className="w-24 md:w-32 h-10 bg-gray-800 flex items-center justify-center rounded-b-lg">
                  <span className="text-gray-200">
                    3rd · {third.totalScore.toFixed(1)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* Stats: top steals + highest buys */}
      <section className="grid md:grid-cols-2 gap-4">
        <div className="bg-gray-900 rounded p-4">
          <h2 className="text-lg font-semibold mb-2">Top steal buys</h2>
          {topSteals.length === 0 ? (
            <p className="text-xs text-gray-400">
              No scored players available yet.
            </p>
          ) : (
            <ul className="text-xs md:text-sm space-y-2">
              {topSteals.map((s, idx) => (
                <li
                  key={`${s.teamId}-${s.playerId}`}
                  className="flex items-center justify-between"
                >
                  <div className="flex flex-col">
                    <span className="font-semibold">{s.playerName}</span>
                    <span className="text-gray-400">
                      {s.teamName} · Score {s.score.toFixed(1)} for{" "}
                      {(s.priceLakhs / 100).toFixed(2)} Cr
                    </span>
                  </div>
                  <span className="text-emerald-400 text-xs ml-2 whitespace-nowrap">
                    #{idx + 1} · {s.valuePerLakh.toFixed(2)} pts/lakh
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-gray-900 rounded p-4">
          <h2 className="text-lg font-semibold mb-2">Biggest buys</h2>
          {topHighBuys.length === 0 ? (
            <p className="text-xs text-gray-400">
              No auction purchases recorded.
            </p>
          ) : (
            <ul className="text-xs md:text-sm space-y-2">
              {topHighBuys.map((s, idx) => (
                <li
                  key={`${s.teamId}-${s.playerId}`}
                  className="flex items-center justify-between"
                >
                  <div className="flex flex-col">
                    <span className="font-semibold">{s.playerName}</span>
                    <span className="text-gray-400">
                      {s.teamName} · {(s.priceLakhs / 100).toFixed(2)} Cr
                    </span>
                  </div>
                  <span className="text-amber-400 text-xs ml-2 whitespace-nowrap">
                    #{idx + 1} · Score {s.score.toFixed(1)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Full standings table */}
      <section className="bg-gray-900 rounded p-4">
        <h2 className="text-lg font-semibold mb-2">All teams</h2>
        {teamRows.length === 0 ? (
          <p className="text-sm text-gray-400">
            No finalized lineups yet.
          </p>
        ) : (
          <table className="w-full text-xs md:text-sm">
            <thead className="text-left text-gray-300 border-b border-gray-700">
              <tr>
                <th className="py-2 pr-3">Rank</th>
                <th className="py-2 pr-3">Team</th>
                <th className="py-2 pr-3 text-right">Total score</th>
              </tr>
            </thead>
            <tbody>
              {teamRows.map((row, index) => (
                <tr
                  key={row.id}
                  className="border-b border-gray-800 last:border-b-0"
                >
                  <td className="py-1.5 pr-3">{index + 1}</td>
                  <td className="py-1.5 pr-3">
                    <span
                      className="inline-block px-2 py-0.5 rounded text-xs font-semibold mr-2"
                      style={{ backgroundColor: row.color }}
                    >
                      {row.name}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-right">
                    {row.totalScore.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
