"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ref, onValue, update } from "firebase/database";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "firebase/auth";
import { db } from "../../../../lib/firebase";

type Team = {
  name: string;
  color: string;
  purseRemainingLakhs: number;
  timeBankSeconds?: number;
  playersBought?: Record<
    string,
    {
      name: string;
      priceLakhs: number;
    }
  >;
  ownerUid?: string;
};

type Player = { name: string };

type RoomConfig = {
  season?: string;
  CF1?: number;
  CF2?: number;
  CF3?: number;
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

type RoomData = {
  teams?: Record<string, Team>;
  players?: Record<string, Player>;
  config?: RoomConfig;
  auction?: { status?: string };
};

type Role = "BAT" | "AR" | "BOWL";

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

function safeNum(n: unknown): number {
  if (n === null || n === undefined) return 0;
  const v = Number(n);
  return isNaN(v) ? 0 : v;
}

function makeEmptySlots() {
  return {
    BAT: Array(6).fill(null) as (string | null)[],
    AR: Array(3).fill(null) as (string | null)[],
    BOWL: Array(6).fill(null) as (string | null)[]
  };
}

// Normalize Firebase slot data (array or object with numeric keys)
// into a fixed-length array of (string | null)
function normalizeRoleSlots(
  raw: unknown,
  length: number
): (string | null)[] {
  if (Array.isArray(raw)) {
    const arr = [...raw] as (string | null)[];
    if (arr.length > length) return arr.slice(0, length);
    while (arr.length < length) arr.push(null);
    return arr;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const arr: (string | null)[] = [];
    for (let i = 0; i < length; i++) {
      const v = (obj[i] ?? obj[String(i)]) as
        | string
        | null
        | undefined;
      arr.push(v ?? null);
    }
    return arr;
  }
  return Array(length).fill(null);
}

export default function TeamSetupPage() {
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
  const [seasonPlayers, setSeasonPlayers] =
    useState<Record<string, SeasonPlayer>>({});
  const [layouts, setLayouts] = useState<TeamLayouts>({});
  const [authUid, setAuthUid] = useState<string | null>(null);
  const [localTeamId, setLocalTeamId] = useState<string | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(
    null
  );
  const [loading, setLoading] = useState(true);

  // ---------- Auth ----------
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) setAuthUid(user.uid);
      else signInAnonymously(auth).catch(console.error);
    });
    return () => unsub();
  }, []);

  // ---------- Local team from localStorage for this room ----------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `ipl_team_${dbRoomId}`;
    const stored = window.localStorage.getItem(key);
    if (stored) setLocalTeamId(stored);
  }, [dbRoomId]);

  // ---------- Subscribe room + layouts ----------
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

  // ---------- Load season players ----------
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
  const players = room?.players || {};

  // ---------- Choose effective team ID ----------
  const teamIds = Object.keys(teams);
  const effectiveTeamId =
    localTeamId && teams[localTeamId]
      ? localTeamId
      : teamIds[0] || null;

  // Keep localStorage in sync with chosen team
  useEffect(() => {
    if (!dbRoomId || !effectiveTeamId || typeof window === "undefined")
      return;
    window.localStorage.setItem(
      `ipl_team_${dbRoomId}`,
      effectiveTeamId
    );
    setLocalTeamId(effectiveTeamId);
  }, [dbRoomId, effectiveTeamId]);

  const localTeam = effectiveTeamId
    ? teams[effectiveTeamId]
    : undefined;

  // ---------- Scores from season stats ----------
  const scoredPlayers: ScoredPlayer[] = useMemo(() => {
    const CF1 = safeNum(cfg.CF1 ?? 30);
    const CF2 = safeNum(cfg.CF2 ?? 2000);
    const CF3 = safeNum(cfg.CF3 ?? 1);
    const list: ScoredPlayer[] = [];
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
      list.push({
        ...p,
        id,
        battingScore,
        bowlingScore,
        allRounderScore
      });
    });
    return list;
  }, [seasonPlayers, cfg.CF1, cfg.CF2, cfg.CF3]);

  const scoreMap = useMemo(() => {
    const m: Record<string, ScoredPlayer> = {};
    scoredPlayers.forEach((p) => (m[p.id] = p));
    return m;
  }, [scoredPlayers]);

  // ---------- Ensure layout exists for this team in DB ----------
  useEffect(() => {
    if (!dbRoomId || !effectiveTeamId) return;
    const layout = layouts[effectiveTeamId];

    if (layout && layout.slots) {
      return;
    }

    const defaultLayout: TeamLayout = {
      finalized: layout?.finalized ?? false,
      slots: makeEmptySlots()
    };

    update(ref(db), {
      [`rooms/${dbRoomId}/teamLayout/${effectiveTeamId}`]:
        defaultLayout
    }).catch(console.error);
  }, [dbRoomId, effectiveTeamId, layouts]);

  // ---------- Local view of layout (normalized slots) ----------
  const myLayout: TeamLayout = useMemo(() => {
    const existing = effectiveTeamId
      ? layouts[effectiveTeamId]
      : undefined;
    const baseSlots = existing?.slots || {};

    return {
      finalized: existing?.finalized ?? false,
      slots: {
        BAT: normalizeRoleSlots(baseSlots.BAT, 6),
        AR: normalizeRoleSlots(baseSlots.AR, 3),
        BOWL: normalizeRoleSlots(baseSlots.BOWL, 6)
      }
    };
  }, [effectiveTeamId, layouts]);

  // ---------- Redirect to leaderboard when all teams finalized ----------
  useEffect(() => {
    if (!room?.teams) return;
    const ids = Object.keys(room.teams);
    if (ids.length === 0) return;
    const allFinalized = ids.every((tid) => {
      const layout = layouts[tid];
      return layout && layout.finalized;
    });
    if (allFinalized) {
      router.push(`/room/${displayRoomId}/leaderboard`);
    }
  }, [layouts, room?.teams, displayRoomId, router]);

  // ---------- Helper sets & lists ----------
  const assignedPlayerIds = useMemo(() => {
    const set = new Set<string>();
    (["BAT", "AR", "BOWL"] as Role[]).forEach((role) => {
      const slotsForRole = myLayout.slots[role] as (string | null)[];
      slotsForRole.forEach((pid) => {
        if (pid) set.add(pid);
      });
    });
    return set;
  }, [myLayout]);

  const myBoughtPlayers = useMemo(() => {
    if (!localTeam?.playersBought) return [];
    return Object.entries(localTeam.playersBought).map(
      ([pid, info]) => {
        const sp = scoreMap[pid];
        return {
          id: pid,
          name: info.name,
          priceLakhs: info.priceLakhs,
          battingScore: sp?.battingScore ?? 0,
          bowlingScore: sp?.bowlingScore ?? 0,
          allRounderScore: sp?.allRounderScore ?? 0,
          alreadyAssigned: assignedPlayerIds.has(pid)
        };
      }
    );
  }, [localTeam, scoreMap, assignedPlayerIds]);

  const handleAssignToSlot = async (
    role: Role,
    index: number,
    playerId: string | null
  ) => {
    if (!dbRoomId || !effectiveTeamId || myLayout.finalized) return;
    const path = `rooms/${dbRoomId}/teamLayout/${effectiveTeamId}/slots/${role}/${index}`;
    await update(ref(db), { [path]: playerId });
  };

  // ---------- Finalize: must use all bought players up to 15 ----------
  const handleFinalize = async () => {
    if (!dbRoomId || !effectiveTeamId) return;

    const batSlots = myLayout.slots.BAT as (string | null)[];
    const arSlots = myLayout.slots.AR as (string | null)[];
    const bowlSlots = myLayout.slots.BOWL as (string | null)[];

    const filledCount = [...batSlots, ...arSlots, ...bowlSlots].filter(
      (p) => p
    ).length;

    const boughtCount = localTeam?.playersBought
      ? Object.keys(localTeam.playersBought).length
      : 0;
    const requiredSlots = Math.min(15, boughtCount);

    if (filledCount < requiredSlots) {
      alert(
        `Fill at least ${requiredSlots} slots (you bought ${boughtCount} players) before finalizing.`
      );
      return;
    }

    await update(ref(db), {
      [`rooms/${dbRoomId}/teamLayout/${effectiveTeamId}/finalized`]:
        true
    });
  };

  // ---------- Guards ----------
  if (loading || !room) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>Loading team setup...</p>
      </main>
    );
  }

  if (!room.teams || Object.keys(room.teams).length === 0) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>No teams found in this room yet.</p>
      </main>
    );
  }

  if (!effectiveTeamId || !localTeam) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>Could not determine your team for this room.</p>
      </main>
    );
  }

  const finalized = !!myLayout.finalized;

  const batSlots = myLayout.slots.BAT as (string | null)[];
  const arSlots = myLayout.slots.AR as (string | null)[];
  const bowlSlots = myLayout.slots.BOWL as (string | null)[];

  const totalFilledSlots = [...batSlots, ...arSlots, ...bowlSlots].filter(
    (p) => p
  ).length;

  const boughtCount = localTeam.playersBought
    ? Object.keys(localTeam.playersBought).length
    : 0;
  const requiredSlots = Math.min(15, boughtCount);

  // ---------- Render helpers ----------
  const renderSlotRow = (role: Role, colorClass: string) => {
    const slots = myLayout.slots[role] as (string | null)[];

    const title =
      role === "BAT"
        ? "Batsmen"
        : role === "AR"
        ? "All-rounders"
        : "Bowlers";

    return (
      <div className={`rounded p-2 mb-3 ${colorClass}`}>
        <p className="text-sm font-semibold mb-1">{title}</p>
        <div className="grid grid-cols-3 gap-2">
          {slots.map((pid, idx) => {
            const sp = pid ? scoreMap[pid] : undefined;
            return (
              <div
                key={idx}
                className={`border border-gray-700 rounded p-2 text-xs min-h-[60px] flex flex-col justify-between ${
                  !pid ? "bg-black/40" : "bg-black/70"
                }`}
                onClick={() => {
                  if (finalized) return;
                  if (selectedPlayerId) {
                    void handleAssignToSlot(
                      role,
                      idx,
                      selectedPlayerId
                    );
                    setSelectedPlayerId(null);
                  }
                }}
              >
                <div className="flex justify-between items-start gap-1">
                  <span className="font-semibold text-[11px]">
                    Slot {idx + 1}
                  </span>
                  {pid && !finalized && (
                    <button
                      className="text-[10px] text-red-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleAssignToSlot(
                          role,
                          idx,
                          null
                        );
                      }}
                    >
                      clear
                    </button>
                  )}
                </div>
                {pid && sp ? (
                  <div className="mt-1">
                    <p className="text-[11px] font-semibold truncate">
                      {sp.name}
                    </p>
                    <p className="text-[10px] text-gray-300">
                      Bat {sp.battingScore.toFixed(1)} · AR{" "}
                      {sp.allRounderScore.toFixed(1)} · Bowl{" "}
                      {sp.bowlingScore.toFixed(1)}
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-500 mt-1">
                    {`Click a ${
                      role === "BAT"
                        ? "batsman"
                        : role === "AR"
                        ? "all-rounder"
                        : "bowler"
                    } to assign here`}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ---------- UI ----------
  return (
    <main className="min-h-screen bg-black text-white p-4 flex flex-col gap-4">
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">
            Team structuring – Room {displayRoomId}
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Arrange your slots; you must use all players you bought, up
            to 15.
          </p>
          <p className="text-sm mt-1">
            You are:{" "}
            <span
              className="font-semibold px-2 py-0.5 rounded"
              style={{ backgroundColor: localTeam.color }}
            >
              {localTeam.name}
            </span>
          </p>
        </div>
        <div className="text-right text-xs text-gray-400">
          <p>Season: {room.config?.season ?? "unknown"}</p>
          <p className="mt-1">
            Players bought: {boughtCount}, required slots:{" "}
            {requiredSlots}
          </p>
          {finalized && (
            <p className="mt-1 text-emerald-400">
              You have finalized your team. Waiting for other teams...
            </p>
          )}
        </div>
      </header>

      <section className="grid md:grid-cols-2 gap-4 flex-1">
        {/* Left: bought players */}
        <aside className="bg-gray-900 rounded p-4 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-2">
            Your bought players
          </h2>
          {myBoughtPlayers.length === 0 ? (
            <p className="text-sm text-gray-400">
              You did not buy any players in the auction.
            </p>
          ) : (
            <ul className="text-xs space-y-1 max-h-[70vh] overflow-y-auto">
              {myBoughtPlayers.map((p) => (
                <li
                  key={p.id}
                  className={`border border-gray-800 rounded p-2 flex flex-col gap-0.5 ${
                    p.alreadyAssigned
                      ? "opacity-60"
                      : "cursor-pointer"
                  } ${
                    selectedPlayerId === p.id
                      ? "ring-2 ring-blue-500"
                      : ""
                  }`}
                  onClick={() => {
                    if (finalized || p.alreadyAssigned) return;
                    setSelectedPlayerId(
                      selectedPlayerId === p.id ? null : p.id
                    );
                  }}
                >
                  <div className="flex justify-between">
                    <span className="font-semibold truncate">
                      {p.name}
                    </span>
                    <span className="text-gray-300">
                      {(p.priceLakhs / 100).toFixed(2)} Cr
                    </span>
                  </div>
                  <p className="text-[10px] text-gray-300">
                    Bat {p.battingScore.toFixed(1)} · AR{" "}
                    {p.allRounderScore.toFixed(1)} · Bowl{" "}
                    {p.bowlingScore.toFixed(1)}
                  </p>
                  {p.alreadyAssigned && (
                    <p className="text-[10px] text-amber-400">
                      Already placed in a slot
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Right: slots */}
        <section className="bg-gray-900 rounded p-4 flex flex-col">
          <h2 className="text-lg font-semibold mb-2">
            Your playing slots
          </h2>
          <p className="text-xs text-gray-400 mb-3">
            Click a player on the left to select, then click a slot to
            assign. Use the{" "}
            <span className="font-semibold">clear</span> button on a
            slot to unassign. You must place all the players you bought
            (up to 15).
          </p>
          <div className="flex-1 overflow-y-auto">
            {renderSlotRow("BAT", "bg-blue-950/40")}
            {renderSlotRow("AR", "bg-emerald-950/40")}
            {renderSlotRow("BOWL", "bg-purple-950/40")}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs">
            <p className="text-gray-400">
              Filled slots: {totalFilledSlots}/{requiredSlots}
            </p>
            <button
              onClick={handleFinalize}
              disabled={finalized}
              className="px-4 py-2 bg-emerald-600 rounded text-sm font-semibold disabled:bg-gray-700"
            >
              {finalized ? "Team finalized" : "Finalize team"}
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}
