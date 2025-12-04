"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ref,
  onValue,
  set,
  update,
  get,
  push
} from "firebase/database";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "firebase/auth";
import { db } from "../../../lib/firebase";

type Team = {
  name: string;
  color: string;
  purseRemainingLakhs: number;
  slots: {
    BAT: number;
    BOWL: number;
    AR: number;
    TOTAL: number;
  };
  timeBankSeconds?: number;
  ownerUid?: string;
  playersBought?: Record<
    string,
    {
      name: string;
      priceLakhs: number;
      notes?: string;
    }
  >;
};

type Player = {
  name: string;
  role?: "BAT" | "BOWL" | "AR";
  basePriceLakhs?: number;
  status?: "not_started" | "in_auction" | "sold" | "unsold";
  soldToTeamId?: string | null;
  soldPriceLakhs?: number | null;
};

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

type AuctionState = {
  sets?: string[][];
  currentSetIndex?: number;
  currentPlayerIndex?: number;
  currentBidLakhs?: number | null;
  currentBidTeamId?: string | null;
  bidDeadlineTs?: number | null;
  status?: "not_started" | "running" | "finished" | "showing_result";
  satOutTeams?: Record<string, boolean>;
  resultMessage?: string | null;
  resultUntilTs?: number | null;
};

type LogEntry = {
  ts: number;
  message: string;
};

type RoomData = {
  status?: string;
  createdAt?: number;
  teams?: Record<string, Team>;
  players?: Record<string, Player>;
  config?: RoomConfig;
  auction?: AuctionState;
  adminUid?: string | null;
  logs?: Record<string, LogEntry>;
};

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

function formatAmount(
  valueLakhs: unknown,
  showInCrores: boolean
): string {
  const v = safeNum(valueLakhs);
  if (showInCrores) {
    const crores = v / 100;
    return `${crores.toFixed(2)} Cr`;
  }
  return `${v.toFixed(2)} L`;
}

const TEAM_COLORS = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#06B6D4",
  "#3B82F6",
  "#6366F1",
  "#A855F7",
  "#EC4899",
  "#F97373"
];

// Base price rule: sets 1–2 => 2 Cr, sets 3–5 => 1 Cr, sets 6+ => 0.5 Cr
function getBasePriceLakhsForSet(setIndex: number): number {
  if (setIndex < 2) return 200; // 2 Cr
  if (setIndex < 5) return 100; // 1 Cr
  return 50; // 0.5 Cr
}

// Fisher–Yates shuffle
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Decide if auction should end early based on purse/players
function computeFinalAuctionStatus(
  nextStatusFromSets: AuctionState["status"],
  teamsAfter: Record<string, Team> | undefined
): AuctionState["status"] {
  const vals = Object.values(teamsAfter || {});
  if (vals.length === 0) return nextStatusFromSets ?? "finished";

  const allNoPurse = vals.every(
    (t) => safeNum(t.purseRemainingLakhs) < 50
  );
  const allOverLimit = vals.every((t) => {
    const count = t.playersBought
      ? Object.keys(t.playersBought).length
      : 0;
    return count >= 25;
  });

  if (allNoPurse && allOverLimit) return "finished";
  if (nextStatusFromSets === "finished") return "finished";
  return "running";
}

function teamOutOfPurse(team: Team | undefined): boolean {
  if (!team) return true;
  return safeNum(team.purseRemainingLakhs) < 50; // 0.5 Cr
}

function isEffectivelySatOut(
  teamId: string,
  auction: AuctionState,
  teams: Record<string, Team>
): boolean {
  const team = teams[teamId];
  if (!team) return true;
  if (teamOutOfPurse(team)) return true;
  return !!auction.satOutTeams?.[teamId];
}

// If exactly one active (not sat-out) team holds the highest bid, instantly sell to them.
async function autoSellToSingleActiveBidder(roomId: string) {
  const auctionRef = ref(db, `rooms/${roomId}/auction`);
  const auctionSnap = await get(auctionRef);
  const auctionNow = (auctionSnap.val() as AuctionState) || {};
  if (auctionNow.status !== "running") return;

  const sets = auctionNow.sets || [];
  const setIndex = auctionNow.currentSetIndex ?? 0;
  const playerIndex = auctionNow.currentPlayerIndex ?? 0;
  const currentSet = sets[setIndex] || [];
  const playerId = currentSet[playerIndex];
  if (!playerId) return;

  const [teamsSnap, playersSnap] = await Promise.all([
    get(ref(db, `rooms/${roomId}/teams`)),
    get(ref(db, `rooms/${roomId}/players`))
  ]);
  const teams = (teamsSnap.val() as Record<string, Team>) || {};
  const players = (playersSnap.val() as Record<string, Player>) || {};

  const activeTeamIds = Object.keys(teams).filter(
    (id) => !isEffectivelySatOut(id, auctionNow, teams)
  );

  if (
    activeTeamIds.length !== 1 ||
    !auctionNow.currentBidTeamId ||
    auctionNow.currentBidLakhs == null
  ) {
    return;
  }

  const lastTeamId = activeTeamIds[0];
  if (lastTeamId !== auctionNow.currentBidTeamId) return;
  const team = teams[lastTeamId];
  const player = players[playerId];
  if (!team || !player) return;

  const newPurse =
    safeNum(team.purseRemainingLakhs) - auctionNow.currentBidLakhs;

  const updates: Record<string, any> = {};
  const playerPath = `rooms/${roomId}/players/${playerId}`;
  const auctionPath = `rooms/${roomId}/auction`;

  updates[`${playerPath}/status`] = "sold";
  updates[`${playerPath}/soldToTeamId`] = lastTeamId;
  updates[`${playerPath}/soldPriceLakhs`] = auctionNow.currentBidLakhs;
  updates[
    `rooms/${roomId}/teams/${lastTeamId}/purseRemainingLakhs`
  ] = newPurse;
  updates[
    `rooms/${roomId}/teams/${lastTeamId}/playersBought/${playerId}`
  ] = {
    name: player.name,
    priceLakhs: auctionNow.currentBidLakhs
  };

  const priceCr = (auctionNow.currentBidLakhs / 100).toFixed(2);
  const resultMessage = `${player.name} sold to ${team.name} for ${priceCr} Cr`;

  const now = Date.now();
  updates[`${auctionPath}/currentBidLakhs`] = null;
  updates[`${auctionPath}/currentBidTeamId`] = null;
  updates[`${auctionPath}/bidDeadlineTs`] = null;
  updates[`${auctionPath}/satOutTeams`] = null;
  updates[`${auctionPath}/status`] = "showing_result";
  updates[`${auctionPath}/resultMessage`] = resultMessage;
  updates[`${auctionPath}/resultUntilTs`] = now + 5000;

  await update(ref(db), updates);
  void appendLog(
    roomId,
    `SOLD (only active bidder): ${player.name} to ${
      team.name
    } for ${auctionNow.currentBidLakhs.toFixed(0)} L`
  );
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: string[][]): string {
  return rows
    .map((r) =>
      r
        .map((cell) => {
          const c = String(cell ?? "");
          if (c.includes('"') || c.includes(",") || c.includes("\n")) {
            return `"${c.replace(/"/g, '""')}"`;
          }
          return c;
        })
        .join(",")
    )
    .join("\n");
}

async function appendLog(roomId: string, message: string) {
  try {
    const logRef = ref(db, `rooms/${roomId}/logs`);
    await push(logRef, {
      ts: Date.now(),
      message
    });
  } catch (err) {
    console.error("Failed to append log", err);
  }
}

export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();

  // Normalize route param to DB key + display code (6-letter codes are case-insensitive)
  const routeParam = params.roomId;
  const rawId = Array.isArray(routeParam)
    ? routeParam[0]
    : String(routeParam);
  const isShortCode =
    rawId.length === 6 && /^[A-Za-z]+$/.test(rawId);
  const dbRoomId = isShortCode ? rawId.toLowerCase() : rawId;
  const displayRoomId = isShortCode ? rawId.toUpperCase() : rawId;

  const [room, setRoom] = useState<RoomData | null>(null);
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [editingConfig, setEditingConfig] =
    useState<RoomConfig | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [seasonPlayers, setSeasonPlayers] =
    useState<Record<string, SeasonPlayer>>({});
  const [loadingSeason, setLoadingSeason] = useState(false);
  const [showInCrores, setShowInCrores] = useState(true);
  const [view, setView] = useState<"config" | "auction">("config");
  const [tab, setTab] =
    useState<"auction" | "results">("auction");
  const [topRightMode, setTopRightMode] =
    useState<"set" | "log">("set");

  const [authUid, setAuthUid] = useState<string | null>(null);
  const [localTeamId, setLocalTeamId] = useState<string | null>(
    null
  );
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [teamNameInput, setTeamNameInput] = useState("");
  const [teamModalError, setTeamModalError] =
    useState<string | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);

  const [customBidInput, setCustomBidInput] = useState("");
  const [remainingSeconds, setRemainingSeconds] = useState<
    number | null
  >(null);
  const [bottomListMode, setBottomListMode] =
    useState<"teams" | "sets">("teams");
  const [selectedTeamId, setSelectedTeamId] = useState<
    string | null
  >(null);
  const [selectedSetIndex, setSelectedSetIndex] = useState<
    number | null
  >(null);

  // ---------- Auth ----------
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) setAuthUid(user.uid);
      else
        signInAnonymously(auth).catch((err) =>
          console.error("Anonymous sign-in failed", err)
        );
    });
    return () => unsub();
  }, []);

  // ---------- Subscribe to room ----------
  useEffect(() => {
    if (!dbRoomId) return;
    const roomRef = ref(db, `rooms/${dbRoomId}`);
    const unsubscribe = onValue(roomRef, (snapshot) => {
      const val = (snapshot.val() as RoomData) || null;
      setRoom(val);
      setLoadingRoom(false);
      if (val?.config && !editingConfig) {
        setEditingConfig(val.config);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [dbRoomId, editingConfig]);

  const cfg: RoomConfig = editingConfig || room?.config || {};

  // Auto-switch to auction view once sets exist
  useEffect(() => {
    if (room?.auction?.sets && room.auction.sets.length > 0) {
      setView("auction");
    }
  }, [room?.auction?.sets, room?.auction?.status]);

  // ---------- Local team selection per room ----------
  useEffect(() => {
    if (!dbRoomId) return;
    if (typeof window === "undefined") return;
    const key = `ipl_team_${dbRoomId}`;
    const stored = window.localStorage.getItem(key);
    if (stored) setLocalTeamId(stored);
    else setShowTeamModal(true);
  }, [dbRoomId]);

  // ---------- Load season players ----------
  useEffect(() => {
    if (!cfg.season) return;
    setLoadingSeason(true);
    const seasonRef = ref(db, `seasons/${cfg.season}/players`);
    const unsubscribe = onValue(seasonRef, (snapshot) => {
      const val =
        (snapshot.val() as Record<string, SeasonPlayer>) || {};
      setSeasonPlayers(val);
      setLoadingSeason(false);
    });
    return () => {
      unsubscribe();
    };
  }, [cfg.season]);

  const handleConfigChange = (
    field: keyof RoomConfig,
    value: string
  ) => {
    setEditingConfig((prev) => ({
      ...(prev || {}),
      [field]:
        field === "season" ? value : Number(value)
    }));
  };

  const handleSaveConfig = async () => {
    if (!dbRoomId || !editingConfig) return;
    try {
      setSavingConfig(true);
      const updates: Record<string, any> = {};
      Object.entries(editingConfig).forEach(([key, value]) => {
        updates[`rooms/${dbRoomId}/config/${key}`] = value;
      });
      await update(ref(db), updates);
    } catch (err) {
      console.error(err);
      alert("Failed to save config");
    } finally {
      setSavingConfig(false);
    }
  };

  // ---------- Scoring ----------
  const scoredPlayers: ScoredPlayer[] = useMemo(() => {
    const CF1 = safeNum(cfg.CF1 ?? 30);
    const CF2 = safeNum(cfg.CF2 ?? 2000);
    const CF3 = safeNum(cfg.CF3 ?? 1);
    const list: ScoredPlayer[] = [];
    Object.entries(seasonPlayers || {}).forEach(([id, p]) => {
      const bat = p.batting as SeasonPlayer["batting"];
      const bowl = p.bowling as SeasonPlayer["bowling"];
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

  const topBatters = useMemo(
    () =>
      [...scoredPlayers]
        .sort((a, b) => b.battingScore - a.battingScore)
        .slice(0, 10),
    [scoredPlayers]
  );
  const topBowlers = useMemo(
    () =>
      [...scoredPlayers]
        .sort((a, b) => b.bowlingScore - a.bowlingScore)
        .slice(0, 10),
    [scoredPlayers]
  );
  const topAllRounders = useMemo(
    () =>
      [...scoredPlayers]
        .sort((a, b) => b.allRounderScore - a.allRounderScore)
        .slice(0, 10),
    [scoredPlayers]
  );

  // ---------- Generate sets + players ----------
  const handleGenerateSets = async () => {
    if (!dbRoomId) return;
    if (scoredPlayers.length === 0) {
      alert("No season players loaded to generate sets.");
      return;
    }
    try {
      const sorted = [...scoredPlayers].sort(
        (a, b) => b.allRounderScore - a.allRounderScore
      );
      const rawSets: string[][] = [];
      const playersObj: Record<string, Player> = {};
      const SET_SIZE = 20;

      sorted.forEach((p, index) => {
        const setIndex = Math.floor(index / SET_SIZE);
        if (!rawSets[setIndex]) rawSets[setIndex] = [];
        rawSets[setIndex].push(p.id);

        const basePriceLakhs = getBasePriceLakhsForSet(setIndex);
        playersObj[p.id] = {
          name: p.name,
          basePriceLakhs,
          status: "not_started",
          soldToTeamId: null,
          soldPriceLakhs: null
        };
      });

      const shuffledSets = rawSets.map((s) => shuffleArray(s));

      const updates: Record<string, any> = {};
      updates[`rooms/${dbRoomId}/players`] = playersObj;
      updates[`rooms/${dbRoomId}/auction`] = {
        sets: shuffledSets,
        currentSetIndex: 0,
        currentPlayerIndex: 0,
        currentBidLakhs: null,
        currentBidTeamId: null,
        bidDeadlineTs: null,
        status: "not_started",
        satOutTeams: null,
        resultMessage: null,
        resultUntilTs: null
      };

      await update(ref(db), updates);
    } catch (err) {
      console.error(err);
      alert("Failed to generate sets.");
    }
  };

  const handleConfigNext = async () => {
    await handleSaveConfig();
    await handleGenerateSets();
    setView("auction");
  };

  // ---------- Advance to next player ----------
  const advanceToNextPlayerFields = (
    auction: AuctionState
  ): {
    nextSetIndex: number;
    nextPlayerIndex: number;
    nextStatus: AuctionState["status"];
  } => {
    const sets = auction.sets || [];
    let setIndex = auction.currentSetIndex ?? 0;
    let playerIndex = auction.currentPlayerIndex ?? 0;
    let status: AuctionState["status"] =
      auction.status ?? "running";

    if (sets.length === 0) {
      return {
        nextSetIndex: 0,
        nextPlayerIndex: 0,
        nextStatus: "finished"
      };
    }

    const currentSet = sets[setIndex] || [];
    if (playerIndex + 1 < currentSet.length) {
      playerIndex += 1;
    } else if (setIndex + 1 < sets.length) {
      setIndex += 1;
      playerIndex = 0;
    } else {
      status = "finished";
    }

    return {
      nextSetIndex: setIndex,
      nextPlayerIndex: playerIndex,
      nextStatus: status
    };
  };

  const handleNextPlayer = async () => {
    if (!dbRoomId || !room?.auction) return;
    if (room.auction.currentBidLakhs != null) {
      alert(
        "Cannot skip to next player while there is an active bid."
      );
      return;
    }
    const tms = room.teams || {};
    const earlyStatus = computeFinalAuctionStatus(
      room.auction.status ?? "running",
      tms
    );
    if (earlyStatus === "finished") {
      await update(ref(db, `rooms/${dbRoomId}/auction`), {
        status: "finished",
        bidDeadlineTs: null
      });
      return;
    }

    const {
      nextSetIndex,
      nextPlayerIndex,
      nextStatus
    } = advanceToNextPlayerFields(room.auction);
    const updates: Record<string, any> = {
      currentSetIndex: nextSetIndex,
      currentPlayerIndex: nextPlayerIndex,
      currentBidLakhs: null,
      currentBidTeamId: null,
      satOutTeams: null,
      status: nextStatus,
      resultMessage: null,
      resultUntilTs: null
    };

    if (nextStatus !== "finished") {
      updates.bidDeadlineTs = Date.now() + 30000;
    } else {
      updates.bidDeadlineTs = null;
    }

    await update(
      ref(db, `rooms/${dbRoomId}/auction`),
      updates
    );
    setCustomBidInput("");
  };

  const handleStartAuction = async () => {
    if (!dbRoomId || !room?.auction) return;
    if (room.auction.status === "finished") {
      alert("Auction already finished.");
      return;
    }

    const auctionRef = ref(db, `rooms/${dbRoomId}/auction`);
    const snap = await get(auctionRef);
    const auctionNow = (snap.val() as AuctionState) || {};
    const sets = auctionNow.sets || [];
    const setIndex = auctionNow.currentSetIndex ?? 0;
    const playerIndex = auctionNow.currentPlayerIndex ?? 0;
    const hasPlayer =
      sets.length > 0 &&
      !!sets[setIndex] &&
      !!sets[setIndex][playerIndex];

    const updates: Record<string, any> = {
      status: "running",
      resultMessage: null,
      resultUntilTs: null
    };

    if (hasPlayer) {
      updates.bidDeadlineTs =
        auctionNow.bidDeadlineTs ?? Date.now() + 30000;
      updates.currentBidLakhs =
        auctionNow.currentBidLakhs ?? null;
      updates.currentBidTeamId =
        auctionNow.currentBidTeamId ?? null;
      updates.satOutTeams = null;
    }

    await update(auctionRef, updates);
  };

  // ---------- Bidding handlers (with auto-sell removed) ----------
  const handleStartBidding = async (
    basePriceLakhs: number,
    playerId: string | null
  ) => {
    if (!dbRoomId || !playerId) return;
    if (!localTeamId) {
      alert("Create or join a team first.");
      return;
    }
    const teams = room?.teams || {};
    const myTeam = teams[localTeamId];
    if (!myTeam) {
      alert("Your team was not found in this room.");
      return;
    }
    if (teamOutOfPurse(myTeam)) {
      alert("You are out of purse for the rest of the auction.");
      return;
    }

    const auctionRef = ref(db, `rooms/${dbRoomId}/auction`);
    const snap = await get(auctionRef);
    const auctionNow = (snap.val() as AuctionState) || {};

    if (auctionNow.status !== "running") {
      alert("Auction is not running.");
      return;
    }
    if (
      auctionNow.bidDeadlineTs &&
      auctionNow.bidDeadlineTs < Date.now()
    ) {
      alert("This player has already timed out.");
      return;
    }
    if (auctionNow.currentBidLakhs != null) {
      // Someone already started bidding.
      return;
    }
    if (isEffectivelySatOut(localTeamId, auctionNow, teams)) {
      alert(
        "You have sat out on this player or are out of purse."
      );
      return;
    }

    const newBidLakhs = basePriceLakhs;
    if (newBidLakhs > safeNum(myTeam.purseRemainingLakhs)) {
      alert("You do not have enough purse for this bid.");
      return;
    }

    const now = Date.now();
    await update(auctionRef, {
      currentBidLakhs: newBidLakhs,
      currentBidTeamId: localTeamId,
      bidDeadlineTs: now + 30000
    });
    await update(
      ref(db, `rooms/${dbRoomId}/players/${playerId}`),
      {
        status: "in_auction"
      }
    );
    setCustomBidInput("");
  };

  const handleRaiseBid = async (
    incrementLakhs: number,
    basePriceLakhs: number,
    playerId: string | null
  ) => {
    if (!dbRoomId || !playerId) return;
    if (!localTeamId) {
      alert("Create or join a team first.");
      return;
    }
    const teams = room?.teams || {};
    const myTeam = teams[localTeamId];
    if (!myTeam) {
      alert("Your team was not found in this room.");
      return;
    }
    if (teamOutOfPurse(myTeam)) {
      alert("You are out of purse for the rest of the auction.");
      return;
    }

    const auctionRef = ref(db, `rooms/${dbRoomId}/auction`);
    const snap = await get(auctionRef);
    const serverAuction = (snap.val() as AuctionState) || {};

    if (serverAuction.currentBidTeamId === localTeamId) {
      alert(
        "You already hold the highest bid for this player."
      );
      return;
    }

    if (serverAuction.status !== "running") {
      alert("Auction is not running.");
      return;
    }
    if (
      serverAuction.bidDeadlineTs &&
      serverAuction.bidDeadlineTs < Date.now()
    ) {
      alert("This player has already timed out.");
      return;
    }
    if (isEffectivelySatOut(localTeamId, serverAuction, teams)) {
      alert(
        "You have sat out on this player or are out of purse."
      );
      return;
    }

    const currentBidLakhs =
      serverAuction.currentBidLakhs ?? basePriceLakhs;
    const newBidLakhs = currentBidLakhs + incrementLakhs;

    if (newBidLakhs % 50 !== 0) {
      alert("Bids must be in multiples of 0.5 Cr (50 Lakhs).");
      return;
    }
    if (newBidLakhs > safeNum(myTeam.purseRemainingLakhs)) {
      alert("You do not have enough purse for this bid.");
      return;
    }

    await update(auctionRef, {
      currentBidLakhs: newBidLakhs,
      currentBidTeamId: localTeamId,
      bidDeadlineTs: Date.now() + 30000
    });
    setCustomBidInput("");
  };

  const handlePlaceCustomBid = async (
    displayValue: string,
    basePriceLakhs: number,
    playerId: string | null
  ) => {
    if (!dbRoomId || !playerId) return;
    if (!localTeamId) {
      alert("Create or join a team first.");
      return;
    }
    const teams = room?.teams || {};
    const myTeam = teams[localTeamId];
    if (!myTeam) {
      alert("Your team was not found in this room.");
      return;
    }
    if (teamOutOfPurse(myTeam)) {
      alert("You are out of purse for the rest of the auction.");
      return;
    }

    const n = Number(displayValue);
    if (isNaN(n) || n <= 0) {
      alert("Enter a positive number.");
      return;
    }
    const customLakhs = showInCrores ? n * 100 : n;

    if (customLakhs % 50 !== 0) {
      alert(
        "Custom bid must be a multiple of 0.5 Cr (50 Lakhs)."
      );
      return;
    }

    const auctionRef = ref(db, `rooms/${dbRoomId}/auction`);
    const snap = await get(auctionRef);
    const serverAuction = (snap.val() as AuctionState) || {};

    if (serverAuction.currentBidTeamId === localTeamId) {
      alert(
        "You already hold the highest bid for this player."
      );
      return;
    }

    if (serverAuction.status !== "running") {
      alert("Auction is not running.");
      return;
    }
    if (
      serverAuction.bidDeadlineTs &&
      serverAuction.bidDeadlineTs < Date.now()
    ) {
      alert("This player has already timed out.");
      return;
    }
    if (isEffectivelySatOut(localTeamId, serverAuction, teams)) {
      alert(
        "You have sat out on this player or are out of purse."
      );
      return;
    }

    const serverCurrent =
      serverAuction.currentBidLakhs ?? basePriceLakhs;
    if (customLakhs <= serverCurrent) {
      alert(
        "Someone has already placed an equal or higher bid. Refresh your view."
      );
      return;
    }
    if (customLakhs > safeNum(myTeam.purseRemainingLakhs)) {
      alert("You do not have enough purse for this bid.");
      return;
    }

    await update(auctionRef, {
      currentBidLakhs: customLakhs,
      currentBidTeamId: localTeamId,
      bidDeadlineTs: Date.now() + 30000
    });
    setCustomBidInput("");
  };

  // ---------- Sit out / timeout / other logic ----------
  const handleSitOut = async () => {
    if (!dbRoomId || !room?.auction) return;
    if (!localTeamId) {
      alert("Create or join a team first.");
      return;
    }
    const teams = room.teams || {};
    if (!teams[localTeamId]) {
      alert("Your team was not found in this room.");
      return;
    }

    const auctionRef = ref(db, `rooms/${dbRoomId}/auction`);
    const auctionSnap = await get(auctionRef);
    const auctionNow = (auctionSnap.val() as AuctionState) || {};
    const sets = auctionNow.sets || [];
    const setIndex = auctionNow.currentSetIndex ?? 0;
    const playerIndex = auctionNow.currentPlayerIndex ?? 0;
    const currentSet = sets[setIndex] || [];
    const playerId = currentSet[playerIndex];
    if (!playerId) return;

    const satOut = auctionNow.satOutTeams || {};
    if (satOut[localTeamId]) {
      return;
    }

    const newSatOut: Record<string, boolean> = {
      ...satOut,
      [localTeamId]: true
    };

    const teamIds = Object.keys(teams);
    const activeTeamIds = teamIds.filter((id) =>
      !isEffectivelySatOut(
        id,
        { ...auctionNow, satOutTeams: newSatOut },
        teams
      )
    );

    // more than one active team left -> just mark sat out
    if (activeTeamIds.length > 1) {
      await update(auctionRef, { satOutTeams: newSatOut });
      return;
    }

    // exactly one active team left
    if (activeTeamIds.length === 1) {
      await update(auctionRef, { satOutTeams: newSatOut });
      await autoSellToSingleActiveBidder(dbRoomId);
      return;
    }

    // everyone effectively sat out => sold to highest bidder or unsold
    const playersRef = ref(db, `rooms/${dbRoomId}/players`);
    const playersSnap = await get(playersRef);
    const pl =
      (playersSnap.val() as Record<string, Player>) || {};
    const player = pl[playerId];
    if (!player) return;

    const teamsRef = ref(db, `rooms/${dbRoomId}/teams`);
    const teamsSnap = await get(teamsRef);
    const currentTeams =
      (teamsSnap.val() as Record<string, Team>) || {};
    const updates: Record<string, any> = {};
    const playerPath = `rooms/${dbRoomId}/players/${playerId}`;
    const auctionPath = `rooms/${dbRoomId}/auction`;
    const { currentBidTeamId, currentBidLakhs } = auctionNow;

    let resultMessage = "";

    if (currentBidTeamId && currentBidLakhs != null) {
      const team = currentTeams[currentBidTeamId];
      if (!team) return;
      const newPurse =
        safeNum(team.purseRemainingLakhs) - currentBidLakhs;

      updates[`${playerPath}/status`] = "sold";
      updates[`${playerPath}/soldToTeamId`] = currentBidTeamId;
      updates[`${playerPath}/soldPriceLakhs`] = currentBidLakhs;
      updates[
        `rooms/${dbRoomId}/teams/${currentBidTeamId}/purseRemainingLakhs`
      ] = newPurse;
      updates[
        `rooms/${dbRoomId}/teams/${currentBidTeamId}/playersBought/${playerId}`
      ] = {
        name: player.name,
        priceLakhs: currentBidLakhs
      };

      const priceCr = (currentBidLakhs / 100).toFixed(2);
      resultMessage = `${player.name} sold to ${team.name} for ${priceCr} Cr`;
      void appendLog(
        dbRoomId,
        `SOLD (all sat out): ${player.name} to ${
          team.name
        } for ${currentBidLakhs.toFixed(0)} L`
      );
    } else {
      updates[`${playerPath}/status`] = "unsold";
      resultMessage = `${player.name} went unsold`;
      void appendLog(
        dbRoomId,
        `UNSOLD (everyone sat out): ${player.name}`
      );
    }

    const now = Date.now();

    updates[`${auctionPath}/currentBidLakhs`] = null;
    updates[`${auctionPath}/currentBidTeamId`] = null;
    updates[`${auctionPath}/bidDeadlineTs`] = null;
    updates[`${auctionPath}/satOutTeams`] = null;
    updates[`${auctionPath}/status`] = "showing_result";
    updates[`${auctionPath}/resultMessage`] = resultMessage;
    updates[`${auctionPath}/resultUntilTs`] = now + 5000;

    await update(ref(db), updates);
  };

  const handleUseTimeBank = async () => {
    if (!dbRoomId || !room?.auction) return;
    if (!localTeamId) {
      alert("Create or join a team first.");
      return;
    }
    const teams = room.teams || {};
    const myTeam = teams[localTeamId];
    if (!myTeam) {
      alert("Your team was not found in this room.");
      return;
    }
    const remaining = safeNum(myTeam.timeBankSeconds ?? 0);
    if (remaining < 15) {
      alert("Not enough time bank left (need at least 15s).");
      return;
    }
    const currentDeadline =
      room.auction.bidDeadlineTs ?? Date.now();
    const newDeadline = currentDeadline + 15000;
    const updates: Record<string, any> = {};
    updates[
      `rooms/${dbRoomId}/auction/bidDeadlineTs`
    ] = newDeadline;
    updates[
      `rooms/${dbRoomId}/teams/${localTeamId}/timeBankSeconds`
    ] = remaining - 15;
    await update(ref(db), updates);
  };

  // ---------- Countdown display ----------
  useEffect(() => {
    const bidDeadlineTs = room?.auction?.bidDeadlineTs ?? null;
    if (!bidDeadlineTs) {
      setRemainingSeconds(null);
      return;
    }

    const updateRemaining = () => {
      const now = Date.now();
      const diffMs = bidDeadlineTs - now;
      const diffSec = Math.floor(diffMs / 1000);
      setRemainingSeconds(diffSec > 0 ? diffSec : 0);
    };

    updateRemaining();
    const id = setInterval(updateRemaining, 250);
    return () => clearInterval(id);
  }, [room?.auction?.bidDeadlineTs]);

  // ---------- Robust timeout finalization ----------
  useEffect(() => {
    const doFinalize = async () => {
      if (!dbRoomId) return;
      const auctionRef = ref(db, `rooms/${dbRoomId}/auction`);
      const auctionSnap = await get(auctionRef);
      const auctionNow = (auctionSnap.val() as AuctionState) || {};
      if (auctionNow.status !== "running") return;
      if (!auctionNow.bidDeadlineTs) return;
      if (Date.now() < auctionNow.bidDeadlineTs) return;

      const sets = auctionNow.sets || [];
      const setIndex = auctionNow.currentSetIndex ?? 0;
      const playerIndex = auctionNow.currentPlayerIndex ?? 0;
      const currentSet = sets[setIndex] || [];
      const playerId = currentSet[playerIndex];
      if (!playerId) return;

      const playersRef = ref(db, `rooms/${dbRoomId}/players`);
      const teamsRef = ref(db, `rooms/${dbRoomId}/teams`);
      const [playersSnap, teamsSnap] = await Promise.all([
        get(playersRef),
        get(teamsRef)
      ]);
      const players =
        (playersSnap.val() as Record<string, Player>) || {};
      const teams =
        (teamsSnap.val() as Record<string, Team>) || {};
      const player = players[playerId];
      if (!player) return;

      const updates: Record<string, any> = {};
      const playerPath = `rooms/${dbRoomId}/players/${playerId}`;
      const auctionPath = `rooms/${dbRoomId}/auction`;
      const { currentBidTeamId, currentBidLakhs } = auctionNow;

      let resultMessage = "";

      if (currentBidTeamId && currentBidLakhs != null) {
        const team = teams[currentBidTeamId];
        if (!team) return;
        const newPurse =
          safeNum(team.purseRemainingLakhs) - currentBidLakhs;

        updates[`${playerPath}/status`] = "sold";
        updates[`${playerPath}/soldToTeamId`] = currentBidTeamId;
        updates[`${playerPath}/soldPriceLakhs`] = currentBidLakhs;
        updates[
          `rooms/${dbRoomId}/teams/${currentBidTeamId}/purseRemainingLakhs`
        ] = newPurse;
        updates[
          `rooms/${dbRoomId}/teams/${currentBidTeamId}/playersBought/${playerId}`
        ] = {
          name: player.name,
          priceLakhs: currentBidLakhs
        };

        const priceCr = (currentBidLakhs / 100).toFixed(2);
        resultMessage = `${player.name} sold to ${team.name} for ${priceCr} Cr`;
        void appendLog(
          dbRoomId,
          `SOLD (timer): ${player.name} to ${
            team.name
          } for ${currentBidLakhs.toFixed(0)} L`
        );
      } else {
        updates[`${playerPath}/status`] = "unsold";
        resultMessage = `${player.name} went unsold`;
        void appendLog(
          dbRoomId,
          `UNSOLD (timer): ${player.name}`
        );
      }

      const now = Date.now();

      updates[`${auctionPath}/currentBidLakhs`] = null;
      updates[`${auctionPath}/currentBidTeamId`] = null;
      updates[`${auctionPath}/bidDeadlineTs`] = null;
      updates[`${auctionPath}/satOutTeams`] = null;
      updates[`${auctionPath}/status`] = "showing_result";
      updates[`${auctionPath}/resultMessage`] = resultMessage;
      updates[`${auctionPath}/resultUntilTs`] = now + 5000;

      await update(ref(db), updates);
    };

    if (
      room?.auction?.status === "running" &&
      room.auction.bidDeadlineTs
    ) {
      const id = setInterval(() => {
        void doFinalize();
      }, 300);
      return () => clearInterval(id);
    }
  }, [
    dbRoomId,
    room?.auction?.status,
    room?.auction?.bidDeadlineTs
  ]);

  // ---------- After 5s result banner, auto-advance ----------
  useEffect(() => {
    const runAdvance = async () => {
      if (!dbRoomId) return;
      const auctionRef = ref(db, `rooms/${dbRoomId}/auction`);
      const [auctionSnap, teamsSnap] = await Promise.all([
        get(auctionRef),
        get(ref(db, `rooms/${dbRoomId}/teams`))
      ]);
      const auctionNow = (auctionSnap.val() as AuctionState) || {};
      if (auctionNow.status !== "showing_result") return;

      const sets = auctionNow.sets || [];
      const {
        nextSetIndex,
        nextPlayerIndex,
        nextStatus
      } = advanceToNextPlayerFields(auctionNow);
      const teamsNow =
        (teamsSnap.val() as Record<string, Team>) || {};
      const finalStatus = computeFinalAuctionStatus(
        nextStatus,
        teamsNow
      );
      let nextDeadline: number | null = null;
      if (finalStatus !== "finished") {
        const nextSet = sets[nextSetIndex];
        if (nextSet && nextSet[nextPlayerIndex]) {
          nextDeadline = Date.now() + 30000;
        }
      }

      await update(auctionRef, {
        currentSetIndex: nextSetIndex,
        currentPlayerIndex: nextPlayerIndex,
        status: finalStatus,
        bidDeadlineTs: nextDeadline,
        currentBidLakhs: null,
        currentBidTeamId: null,
        satOutTeams: null,
        resultMessage: null,
        resultUntilTs: null
      });
    };

    const auction = room?.auction;
    if (!auction || auction.status !== "showing_result") return;
    const until = auction.resultUntilTs;
    if (!until) {
      void runAdvance();
      return;
    }
    const delay = until - Date.now();
    if (delay <= 0) {
      void runAdvance();
      return;
    }
    const id = setTimeout(() => {
      void runAdvance();
    }, delay);
    return () => clearTimeout(id);
  }, [
    room?.auction?.status,
    room?.auction?.resultUntilTs,
    dbRoomId,
    room?.teams
  ]);

  // ---------- Redirect to team setup when auction finishes ----------
  useEffect(() => {
    if (room?.auction?.status === "finished") {
      router.push(`/room/${displayRoomId}/team-setup`);
    }
  }, [room?.auction?.status, displayRoomId, router]);

  // ---------- Create team ----------
  const handleCreateTeam = async () => {
    if (!dbRoomId) return;
    const name = teamNameInput.trim();
    if (!name) {
      setTeamModalError("Enter a team name.");
      return;
    }
    if (!authUid) {
      setTeamModalError(
        "Authentication not ready. Wait a second and try again."
      );
      return;
    }
    try {
      setCreatingTeam(true);
      setTeamModalError(null);

      const teamsRef = ref(db, `rooms/${dbRoomId}/teams`);
      const snap = await get(teamsRef);
      const existingTeams =
        (snap.val() as Record<string, Team>) || {};
      const nameTaken = Object.values(existingTeams).some(
        (t) =>
          t.name.toLowerCase() === name.toLowerCase()
      );
      if (nameTaken) {
        setTeamModalError(
          "This team name is already taken in this room."
        );
        setCreatingTeam(false);
        return;
      }

      const usedColors = new Set(
        Object.values(existingTeams).map((t) => t.color)
      );
      const color =
        TEAM_COLORS.find((c) => !usedColors.has(c)) || "#FFFFFF";

      const now = Date.now();
      const newTeamRef = push(teamsRef);
      await set(newTeamRef, {
        name,
        color,
        purseRemainingLakhs: 10000,
        timeBankSeconds: 120,
        slots: { BAT: 0, BOWL: 0, AR: 0, TOTAL: 0 },
        ownerUid: authUid,
        createdAt: now
      });

      if (!room?.adminUid) {
        await update(ref(db), {
          [`rooms/${dbRoomId}/adminUid`]: authUid
        });
      }

      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          `ipl_team_${dbRoomId}`,
          newTeamRef.key!
        );
      }
      setLocalTeamId(newTeamRef.key!);
      setShowTeamModal(false);
    } catch (err) {
      console.error(err);
      setTeamModalError("Failed to create team. Try again.");
    } finally {
      setCreatingTeam(false);
    }
  };

  // ---------- Export CSV (admin) ----------
  const handleExportCsv = () => {
    if (!room) return;
    const tms = room.teams || {};
    const pls = room.players || {};
    const teamRows: string[][] = [
      ["teamId", "name", "color", "purseRemainingLakhs", "timeBankSeconds"]
    ];
    Object.entries(tms).forEach(([id, t]) => {
      teamRows.push([
        id,
        t.name,
        t.color,
        String(safeNum(t.purseRemainingLakhs)),
        String(safeNum(t.timeBankSeconds ?? 0))
      ]);
    });

    const playerRows: string[][] = [
      ["playerId", "name", "status", "soldToTeamId", "soldPriceLakhs"]
    ];
    Object.entries(pls).forEach(([id, p]) => {
      playerRows.push([
        id,
        p.name,
        p.status ?? "",
        p.soldToTeamId ?? "",
        String(safeNum(p.soldPriceLakhs ?? 0))
      ]);
    });

    downloadTextFile(
      `teams-${displayRoomId}.csv`,
      toCsv(teamRows)
    );
    downloadTextFile(
      `players-${displayRoomId}.csv`,
      toCsv(playerRows)
    );
  };

  // ---------- Default selections ----------
  useEffect(() => {
    const tms = room?.teams || {};
    if (!selectedTeamId) {
      if (localTeamId && tms[localTeamId]) {
        setSelectedTeamId(localTeamId);
      } else {
        const firstId = Object.keys(tms)[0];
        if (firstId) setSelectedTeamId(firstId);
      }
    }
    if (room?.auction && selectedSetIndex == null) {
      setSelectedSetIndex(room.auction.currentSetIndex ?? 0);
    }
  }, [
    room?.teams,
    room?.auction,
    localTeamId,
    selectedTeamId,
    selectedSetIndex
  ]);

  // ---------- Guards ----------
  if (loadingRoom) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center">
        <p>Loading room...</p>
      </main>
    );
  }

  if (!room) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">
            Room not found
          </h1>
          <p className="mb-4">
            Check the URL or room ID.
          </p>
          <button
            onClick={() => router.push("/")}
            className="px-4 py-2 bg-blue-600 rounded"
          >
            Back to home
          </button>
        </div>
      </main>
    );
  }

  const teams = room.teams || {};
  const players = room.players || {};
  const cfgDisplay: RoomConfig = editingConfig || room.config || {};
  const auction = room.auction || {};
  const sets = auction.sets || [];
  const currentSetIndex = auction.currentSetIndex ?? 0;
  const currentPlayerIndex = auction.currentPlayerIndex ?? 0;

  const myTeam = localTeamId ? teams[localTeamId] : undefined;
  const isAdmin = !!authUid && room.adminUid === authUid;
  const adminTeam =
    room.adminUid && Object.keys(teams).length > 0
      ? Object.values(teams).find(
          (t) => t.ownerUid === room.adminUid
        )
      : undefined;

  let currentAuctionPlayer: ScoredPlayer | null = null;
  let currentPlayerBasePriceLakhs = 0;
  let currentPlayerId: string | null = null;

  if (
    sets[currentSetIndex] &&
    sets[currentSetIndex][currentPlayerIndex]
  ) {
    const pid =
      sets[currentSetIndex][currentPlayerIndex];
    currentPlayerId = pid;
    currentAuctionPlayer =
      scoredPlayers.find((p) => p.id === pid) ?? null;
    const roomPlayer = players[pid];
    currentPlayerBasePriceLakhs =
      roomPlayer?.basePriceLakhs ?? 0;
  }

  const playersLeftInSet =
    sets[currentSetIndex]?.length != null
      ? sets[currentSetIndex].length -
        currentPlayerIndex -
        1
      : 0;

  const selectedTeam =
    selectedTeamId && teams[selectedTeamId]
      ? teams[selectedTeamId]
      : undefined;

  const currentBidLakhs =
    auction.currentBidLakhs ?? currentPlayerBasePriceLakhs;
  const isMyTeamHighestBidder =
    !!localTeamId &&
    auction.currentBidTeamId === localTeamId;

  const currentSetPlayerIds = sets[currentSetIndex] || [];
  const currentSetPlayersDetailed = currentSetPlayerIds.map(
    (pid) => {
      const sp =
        scoredPlayers.find((p) => p.id === pid) ?? null;
      const rp = players[pid];
      const soldTeam =
        rp?.soldToTeamId && teams[rp.soldToTeamId]
          ? teams[rp.soldToTeamId]
          : undefined;
      return {
        id: pid,
        name: sp?.name ?? rp?.name ?? pid,
        battingScore: sp?.battingScore,
        bowlingScore: sp?.bowlingScore,
        allRounderScore: sp?.allRounderScore,
        status: rp?.status ?? "not_started",
        teamColor: soldTeam?.color
      };
    }
  );

  const allSetsList = sets.map((s, idx) => ({
    index: idx,
    size: s.length
  }));

  const totalSeconds = 30;
  const fraction =
    remainingSeconds == null
      ? 0
      : Math.max(
          0,
          Math.min(1, remainingSeconds / totalSeconds)
        );
  const sweepDeg = fraction * 360;
  const timerRingStyle: CSSProperties = {
    background: `conic-gradient(${
      remainingSeconds != null && remainingSeconds <= 5
        ? "#f97373"
        : "#22C55E"
    } ${sweepDeg}deg, #111827 ${sweepDeg}deg)`
  };

  const allSoldPlayers = Object.entries(players).filter(
    ([, p]) => p.status === "sold"
  );

  const logs = room.logs || {};
  const logEntries = Object.entries(logs).sort(
    (a, b) => a[1].ts - b[1].ts
  );

  const myTeamOutOfPurse = teamOutOfPurse(myTeam);
  const canBid =
    auction.status === "running" &&
    !!currentPlayerId &&
    !isMyTeamHighestBidder &&
    !myTeamOutOfPurse;
  const canUseTimeBank =
    auction.status === "running" &&
    !!currentPlayerId &&
    !!myTeam &&
    safeNum(myTeam.timeBankSeconds ?? 0) >= 15;
  const canSitOut =
    auction.status === "running" && !!currentPlayerId;
  const isSatOutForCurrentPlayer =
    !!auction.satOutTeams?.[localTeamId ?? ""];

  const handleCopyRoomCode = async () => {
    try {
      if (typeof navigator !== "undefined") {
        await navigator.clipboard.writeText(displayRoomId);
        alert("Room code copied to clipboard");
      } else {
        alert("Clipboard API not available in this browser.");
      }
    } catch (err) {
      console.error("Copy failed", err);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white p-4 flex flex-col gap-4">
      {/* Top bar */}
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">
            Idiots Premier League Auction
          </h1>
          <p className="text-sm text-gray-400 flex items-center gap-2 mt-1">
            Room code{" "}
            <span className="font-mono text-base">
              {displayRoomId}
            </span>
            <button
              onClick={handleCopyRoomCode}
              className="px-2 py-0.5 text-xs rounded bg-gray-800 border border-gray-600"
            >
              Copy
            </button>
          </p>
          <p className="text-sm text-gray-400">
            Season:{" "}
            {cfgDisplay.season ??
              room.config?.season ??
              "unknown"}
          </p>
          {myTeam && (
            <p className="text-sm mt-1">
              You are{" "}
              <span
                className="font-semibold px-2 py-0.5 rounded"
                style={{ backgroundColor: myTeam.color }}
              >
                {myTeam.name}
              </span>
              {isAdmin && (
                <span className="ml-2 text-xs bg-amber-500 text-black px-2 py-0.5 rounded">
                  Admin
                </span>
              )}
            </p>
          )}
          {!isAdmin && adminTeam && (
            <p className="text-xs text-gray-400 mt-1">
              Auction controlled by {adminTeam.name}
            </p>
          )}
          <div className="flex gap-2 mt-2 text-xs">
            <button
              onClick={() => setTab("auction")}
              className={`px-2 py-1 rounded ${
                tab === "auction" ? "bg-blue-600" : "bg-gray-800"
              }`}
            >
              Auction
            </button>
            <button
              onClick={() => setTab("results")}
              disabled={
                (auction.status ?? "not_started") !== "finished"
              }
              className={`px-2 py-1 rounded ${
                tab === "results" ? "bg-blue-600" : "bg-gray-800"
              } disabled:bg-gray-700`}
            >
              Results
            </button>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 text-sm">
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                setShowInCrores((prev) => !prev)
              }
              className="px-3 py-1 rounded bg-gray-800 border border-gray-600 text-xs"
            >
              View in {showInCrores ? "Crores" : "Lakhs"}
            </button>
            <button
              onClick={handleExportCsv}
              disabled={!isAdmin}
              className="px-3 py-1 bg-gray-700 rounded disabled:bg-gray-900 text-xs"
            >
              Export CSV (admin)
            </button>
          </div>
          <div className="text-right text-xs text-gray-400">
            <p>
              Status:{" "}
              <span className="font-semibold capitalize">
                {auction.status ?? "waiting"}
              </span>
            </p>
            {room.createdAt && (
              <p className="text-gray-400 text-xs">
                Created{" "}
                {new Date(
                  room.createdAt
                ).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      </header>

      {/* Team creation modal */}
      {showTeamModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded p-4 w-full max-w-sm">
            <h2 className="text-lg font-semibold mb-2">
              Create your team
            </h2>
            <p className="text-xs text-gray-400 mb-2">
              This device will be linked to your team.
              Choose a unique team name for this room.
            </p>
            <input
              type="text"
              value={teamNameInput}
              onChange={(e) =>
                setTeamNameInput(e.target.value)
              }
              className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 mb-2"
              placeholder="Team name"
            />
            {teamModalError && (
              <p className="text-xs text-red-400 mb-2">
                {teamModalError}
              </p>
            )}
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => {
                  setShowTeamModal(false);
                  if (!localTeamId) {
                    setShowTeamModal(true);
                  }
                }}
                className="px-3 py-1 rounded bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTeam}
                disabled={creatingTeam}
                className="px-3 py-1 rounded bg-emerald-600 disabled:bg-gray-700"
              >
                {creatingTeam ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      {tab === "auction" && (
        <section className="grid md:grid-cols-2 gap-4">
          {/* Left: Config or auction */}
          <div className="space-y-4">
            {view === "config" && (
              <section className="bg-gray-900 rounded p-4 flex flex-col gap-4">
                <div>
                  <h2 className="text-lg font-semibold mb-2">
                    Step 1: Conversion factors
                  </h2>
                  <p className="text-xs text-gray-400 mb-3">
                    Only the room admin should change these
                    values. Then click "Next" to prepare the auction.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <label className="block text-xs mb-1">
                        Season
                      </label>
                      <input
                        type="text"
                        value={
                          cfgDisplay.season ??
                          room.config?.season ??
                          ""
                        }
                        onChange={(e) =>
                          handleConfigChange(
                            "season",
                            e.target.value
                          )
                        }
                        disabled={!isAdmin}
                        className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-xs mb-1">
                        CF1 (Wickets)
                      </label>
                      <input
                        type="number"
                        value={cfgDisplay.CF1 ?? ""}
                        onChange={(e) =>
                          handleConfigChange(
                            "CF1",
                            e.target.value
                          )
                        }
                        disabled={!isAdmin}
                        className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-xs mb-1">
                        CF2 (Bowling)
                      </label>
                      <input
                        type="number"
                        value={cfgDisplay.CF2 ?? ""}
                        onChange={(e) =>
                          handleConfigChange(
                            "CF2",
                            e.target.value
                          )
                        }
                        disabled={!isAdmin}
                        className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="block text-xs mb-1">
                        CF3 (AR)
                      </label>
                      <input
                        type="number"
                        value={cfgDisplay.CF3 ?? ""}
                        onChange={(e) =>
                          handleConfigChange(
                            "CF3",
                            e.target.value
                          )
                        }
                        disabled={!isAdmin}
                        className="w-full px-2 py-1 rounded bg-gray-800 border border-gray-700 disabled:opacity-60"
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 items-center">
                    <button
                      onClick={handleSaveConfig}
                      disabled={savingConfig || !isAdmin}
                      className="px-4 py-2 bg-blue-600 rounded disabled:bg-gray-600 text-sm"
                    >
                      {savingConfig
                        ? "Saving..."
                        : "Save config"}
                    </button>
                    <button
                      onClick={handleConfigNext}
                      disabled={!isAdmin}
                      className="px-4 py-2 bg-purple-600 rounded text-sm disabled:bg-gray-700"
                    >
                      Next: prepare auction
                    </button>
                    {!isAdmin && (
                      <p className="text-xs text-gray-400">
                        Only the admin (first UID to create a team)
                        can change factors and generate sets.
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <h2 className="text-lg font-semibold mb-3">
                    Ranking preview per room
                  </h2>
                  {loadingSeason ? (
                    <p className="text-sm text-gray-400">
                      Loading season players...
                    </p>
                  ) : scoredPlayers.length === 0 ? (
                    <p className="text-sm text-gray-400">
                      No players loaded for this season. Import
                      `seasons/{cfgDisplay.season}/players`.
                    </p>
                  ) : (
                    <div className="grid md:grid-cols-3 gap-3 text-xs">
                      <div>
                        <h3 className="font-semibold mb-1">
                          Top Batting Score
                        </h3>
                        <ol className="list-decimal list-inside space-y-1">
                          {topBatters.map((p) => (
                            <li key={p.id}>
                              {p.name}{" "}
                              <span className="text-gray-400">
                                ({p.battingScore.toFixed(2)})
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">
                          Top Bowling Score
                        </h3>
                        <ol className="list-decimal list-inside space-y-1">
                          {topBowlers.map((p) => (
                            <li key={p.id}>
                              {p.name}{" "}
                              <span className="text-gray-400">
                                ({p.bowlingScore.toFixed(2)})
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                      <div>
                        <h3 className="font-semibold mb-1">
                          Top All-Rounder Score
                        </h3>
                        <ol className="list-decimal list-inside space-y-1">
                          {topAllRounders.map((p) => (
                            <li key={p.id}>
                              {p.name}{" "}
                              <span className="text-gray-400">
                                ({p.allRounderScore.toFixed(2)})
                              </span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {view === "auction" && (
              <section className="bg-gray-900 rounded p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between text-sm mb-1">
                  <div>
                    <p>
                      Set{" "}
                      <span className="font-semibold">
                        {sets.length === 0
                          ? "-"
                          : currentSetIndex + 1}{" "}
                        / {sets.length || "-"}
                      </span>
                    </p>
                    <p className="text-gray-400">
                      Players left in this set:{" "}
                      {playersLeftInSet < 0
                        ? 0
                        : playersLeftInSet}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleStartAuction}
                      disabled={
                        auction.status === "running" ||
                        auction.status === "showing_result" ||
                        !isAdmin
                      }
                      className="px-4 py-2 rounded text-xs bg-emerald-600 disabled:bg-gray-700 font-semibold"
                    >
                      {auction.status === "running"
                        ? "Auction running"
                        : "Start auction (admin)"}
                    </button>
                    <button
                      onClick={handleNextPlayer}
                      disabled={
                        !isAdmin ||
                        auction.currentBidLakhs != null ||
                        auction.status === "showing_result"
                      }
                      className="px-4 py-2 rounded text-xs bg-blue-600 disabled:bg-gray-700 font-semibold"
                    >
                      Next player (admin)
                    </button>
                  </div>
                </div>

                <div className="grid md:grid-cols-3 gap-4">
                  {/* Top-left: current player */}
                  <div className="bg-black/40 rounded p-3">
                    <h2 className="text-lg font-semibold mb-2">
                      Current player
                    </h2>
                    {!currentAuctionPlayer ? (
                      <p className="text-sm text-gray-400">
                        No current player. Admin must generate sets
                        and start auction.
                      </p>
                    ) : (
                      <>
                        <p className="text-2xl font-bold mb-1">
                          {currentAuctionPlayer.name}
                        </p>
                        <p className="text-base mb-3">
                          Base price{" "}
                          <span className="font-bold text-xl">
                            {formatAmount(
                              currentPlayerBasePriceLakhs,
                              showInCrores
                            )}
                          </span>
                        </p>
                        <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                          <div>
                            <p className="font-semibold mb-1">
                              Batting stats
                            </p>
                            <p>
                              Runs{" "}
                              {
                                currentAuctionPlayer.batting
                                  .runs
                              }
                            </p>
                            <p>
                              Avg{" "}
                              {
                                currentAuctionPlayer.batting
                                  .avg
                              }
                            </p>
                            <p>
                              SR{" "}
                              {
                                currentAuctionPlayer.batting
                                  .sr
                              }
                            </p>
                            <p>
                              4s/6s{" "}
                              {
                                currentAuctionPlayer.batting
                                  .fours
                              }
                              /
                              {
                                currentAuctionPlayer.batting
                                  .sixes
                              }
                            </p>
                          </div>
                          <div>
                            <p className="font-semibold mb-1">
                              Bowling stats
                            </p>
                            <p>
                              Wkts{" "}
                              {
                                currentAuctionPlayer.bowling
                                  .wickets
                              }
                            </p>
                            <p>
                              Avg{" "}
                              {
                                currentAuctionPlayer.bowling
                                  .avg
                              }
                            </p>
                            <p>
                              Econ{" "}
                              {
                                currentAuctionPlayer.bowling
                                  .econ
                              }
                            </p>
                            <p>
                              SR{" "}
                              {
                                currentAuctionPlayer.bowling
                                  .sr
                              }
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 grid grid-cols-3 gap-3 text-center">
                          <div className="bg-gray-800 rounded p-2">
                            <p className="text-[10px] text-gray-400">
                              Bat score
                            </p>
                            <p className="text-2xl font-bold">
                              {currentAuctionPlayer.battingScore.toFixed(
                                1
                              )}
                            </p>
                          </div>
                          <div className="bg-gray-800 rounded p-2">
                            <p className="text-[10px] text-gray-400">
                              Bowl score
                            </p>
                            <p className="text-2xl font-bold">
                              {currentAuctionPlayer.bowlingScore.toFixed(
                                1
                              )}
                            </p>
                          </div>
                          <div className="bg-gray-800 rounded p-2">
                            <p className="text-[10px] text-gray-400">
                              AR score
                            </p>
                            <p className="text-2xl font-bold">
                              {currentAuctionPlayer.allRounderScore.toFixed(
                                1
                              )}
                            </p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Top-middle: bidding / sit-out / time bank */}
                  <div className="bg-black/40 rounded p-3 flex flex-col justify-between relative">
                    {auction.status === "showing_result" &&
                      auction.resultMessage && (
                        <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-10">
                          <div className="bg-gray-900 border border-emerald-500 rounded px-4 py-3 text-center max-w-xs">
                            <p className="text-sm font-semibold">
                              {auction.resultMessage}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                              Next player will start in a moment...
                            </p>
                          </div>
                        </div>
                      )}
                    <div>
                      <h2 className="text-lg font-semibold mb-3">
                        Bidding
                      </h2>
                      {!currentAuctionPlayer ? (
                        <p className="text-sm text-gray-400">
                          Waiting for a current player.
                        </p>
                      ) : (
                        <div className="flex items-center gap-4 mb-4">
                          <div className="relative w-40 h-40">
                            <div
                              className="w-40 h-40 rounded-full flex items-center justify-center"
                              style={timerRingStyle}
                            >
                              <button
                                className="w-32 h-32 rounded-full bg-blue-600 flex flex-col items-center justify-center text-sm md:text-base font-bold shadow-lg disabled:bg-gray-700 disabled:text-gray-300"
                                disabled={
                                  auction.status !== "running" ||
                                  !currentPlayerId ||
                                  isMyTeamHighestBidder ||
                                  isSatOutForCurrentPlayer ||
                                  myTeamOutOfPurse
                                }
                                onClick={() => {
                                  if (
                                    !currentPlayerId ||
                                    !currentAuctionPlayer
                                  )
                                    return;
                                  if (
                                    auction.currentBidLakhs == null
                                  ) {
                                    void handleStartBidding(
                                      currentPlayerBasePriceLakhs,
                                      currentPlayerId
                                    );
                                  } else {
                                    void handleRaiseBid(
                                      50,
                                      currentPlayerBasePriceLakhs,
                                      currentPlayerId
                                    );
                                  }
                                }}
                              >
                                <span className="text-[11px] uppercase">
                                  {auction.currentBidLakhs == null
                                    ? "Start bid"
                                    : "Bid +0.5 Cr"}
                                </span>
                                <span className="text-lg">
                                  {remainingSeconds == null
                                    ? "--"
                                    : remainingSeconds}
                                </span>
                              </button>
                            </div>
                          </div>

                          <div className="flex-1 text-sm">
                            <div className="mb-3 border border-gray-700 rounded p-2 bg-gray-900">
                              <p className="text-xs text-gray-400">
                                Current bid
                              </p>
                              <p className="text-2xl font-extrabold">
                                {formatAmount(
                                  currentBidLakhs,
                                  showInCrores
                                )}
                              </p>
                              {auction.currentBidTeamId &&
                                teams[auction.currentBidTeamId] && (
                                  <p className="text-xs text-gray-300 mt-1">
                                    Held by{" "}
                                    <span className="font-semibold">
                                      {
                                        teams[
                                          auction
                                            .currentBidTeamId
                                        ].name
                                      }
                                    </span>
                                  </p>
                                )}
                            </div>

                            <div className="space-y-2">
                              <div className="flex gap-2 text-xs">
                                <input
                                  type="number"
                                  value={customBidInput}
                                  onChange={(e) =>
                                    setCustomBidInput(
                                      e.target.value
                                    )
                                  }
                                  className="flex-1 px-2 py-1 rounded bg-gray-800 border border-gray-700"
                                  placeholder={
                                    showInCrores
                                      ? "Custom bid (Cr)"
                                      : "Custom (Lakhs)"
                                  }
                                />
                                <button
                                  disabled={
                                    !canBid || !currentPlayerId
                                  }
                                  onClick={() => {
                                    if (
                                      !currentAuctionPlayer ||
                                      !currentPlayerId
                                    )
                                      return;
                                    void handlePlaceCustomBid(
                                      customBidInput,
                                      currentPlayerBasePriceLakhs,
                                      currentPlayerId
                                    );
                                  }}
                                  className="px-3 py-1 rounded bg-purple-600 disabled:bg-gray-700"
                                >
                                  Place custom
                                </button>
                              </div>
                              <p className="text-xs text-gray-400">
                                Bids are in steps of 0.5 Cr; timer
                                starts at 30s when player appears.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-xs mt-2">
                      <button
                        disabled={!canSitOut || isSatOutForCurrentPlayer}
                        onClick={() => void handleSitOut()}
                        className="px-3 py-1 rounded bg-gray-800 border border-gray-700 disabled:bg-gray-900 disabled:text-gray-500"
                      >
                        {isSatOutForCurrentPlayer
                          ? "You sat out"
                          : "Sit out this player"}
                      </button>
                      <button
                        disabled={!canUseTimeBank}
                        onClick={() => void handleUseTimeBank()}
                        className="px-3 py-1 rounded bg-amber-500 text-black disabled:bg-gray-700 disabled:text-gray-300"
                      >
                        Use 15s time bank (
                        {safeNum(
                          myTeam?.timeBankSeconds ?? 0
                        )}{" "}
                        s left)
                      </button>
                    </div>
                  </div>

                  {/* Top-right: sets list / log */}
                  <div className="bg-black/40 rounded p-3 flex flex-col">
                    <div className="flex items-center justify-between mb-2">
                      <h2 className="text-lg font-semibold">
                        {topRightMode === "set"
                          ? "Sets overview"
                          : "Auction log"}
                      </h2>
                      <div className="flex gap-1 text-[11px]">
                        <button
                          onClick={() => setTopRightMode("set")}
                          className={`px-2 py-0.5 rounded ${
                            topRightMode === "set"
                              ? "bg-blue-600"
                              : "bg-gray-800"
                          }`}
                        >
                          Sets
                        </button>
                        <button
                          onClick={() => setTopRightMode("log")}
                          className={`px-2 py-0.5 rounded ${
                            topRightMode === "log"
                              ? "bg-blue-600"
                              : "bg-gray-800"
                          }`}
                        >
                          Log
                        </button>
                      </div>
                    </div>
                    {topRightMode === "set" ? (
                      <div className="text-xs space-y-1 max-h-64 overflow-y-auto">
                        {allSetsList.map((s) => (
                          <div
                            key={s.index}
                            className={`flex items-center justify-between px-2 py-1 rounded ${
                              s.index === currentSetIndex
                                ? "bg-blue-900/60"
                                : "bg-gray-900"
                            }`}
                          >
                            <span>
                              Set {s.index + 1}{" "}
                              {s.index === currentSetIndex &&
                                "(current)"}
                            </span>
                            <span className="text-gray-400">
                              {s.size} players
                            </span>
                          </div>
                        ))}
                        {allSetsList.length === 0 && (
                          <p className="text-gray-400">
                            No sets generated yet.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs max-h-64 overflow-y-auto space-y-1">
                        {logEntries.length === 0 && (
                          <p className="text-gray-400">
                            No log entries yet.
                          </p>
                        )}
                        {logEntries.map(([id, entry]) => (
                          <div
                            key={id}
                            className="border-b border-gray-800 pb-1"
                          >
                            <p className="text-[11px] text-gray-500">
                              {new Date(
                                entry.ts
                              ).toLocaleTimeString()}
                            </p>
                            <p>{entry.message}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>

          {/* Right side: bottom panel (teams or set players) */}
          <section className="bg-gray-900 rounded p-4 flex flex-col">
            <div className="flex items-center justify-between mb-2 text-sm">
              <div>
                <button
                  onClick={() => setBottomListMode("teams")}
                  className={`px-3 py-1 rounded mr-1 ${
                    bottomListMode === "teams"
                      ? "bg-blue-600"
                      : "bg-gray-800"
                  }`}
                >
                  Teams
                </button>
                <button
                  onClick={() => setBottomListMode("sets")}
                  className={`px-3 py-1 rounded ${
                    bottomListMode === "sets"
                      ? "bg-blue-600"
                      : "bg-gray-800"
                  }`}
                >
                  Current set players
                </button>
              </div>
              {bottomListMode === "teams" && (
                <select
                  value={selectedTeamId ?? ""}
                  onChange={(e) =>
                    setSelectedTeamId(e.target.value)
                  }
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
                >
                  {Object.entries(teams).map(([id, t]) => (
                    <option key={id} value={id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              {bottomListMode === "sets" && (
                <select
                  value={selectedSetIndex ?? 0}
                  onChange={(e) =>
                    setSelectedSetIndex(
                      Number(e.target.value)
                    )
                  }
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
                >
                  {sets.map((_, idx) => (
                    <option key={idx} value={idx}>
                      Set {idx + 1}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {bottomListMode === "teams" ? (
              <div className="flex-1 overflow-y-auto text-xs">
                {!selectedTeam ? (
                  <p className="text-gray-400">
                    No team selected.
                  </p>
                ) : (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block w-3 h-3 rounded"
                          style={{
                            backgroundColor: selectedTeam.color
                          }}
                        />
                        <span className="font-semibold">
                          {selectedTeam.name}
                        </span>
                      </div>
                      <div className="text-right text-[11px] text-gray-400">
                        <p>
                          Purse left:{" "}
                          <span className="font-semibold">
                            {formatAmount(
                              selectedTeam.purseRemainingLakhs,
                              showInCrores
                            )}
                          </span>
                        </p>
                        <p>
                          Time bank:{" "}
                          {safeNum(
                            selectedTeam.timeBankSeconds ?? 0
                          )}{" "}
                          s
                        </p>
                        <p>
                          Players bought:{" "}
                          {selectedTeam.playersBought
                            ? Object.keys(
                                selectedTeam.playersBought
                              ).length
                            : 0}
                        </p>
                      </div>
                    </div>
                    <div className="border-t border-gray-800 pt-2">
                      <h3 className="font-semibold mb-1">
                        Bought players
                      </h3>
                      {selectedTeam.playersBought ? (
                        <ul className="space-y-1">
                          {Object.entries(
                            selectedTeam.playersBought
                          ).map(([pid, info]) => {
                            const sp =
                              scoredPlayers.find(
                                (p) => p.id === pid
                              ) ?? null;
                            return (
                              <li
                                key={pid}
                                className="flex justify-between items-center border border-gray-800 rounded px-2 py-1"
                              >
                                <div>
                                  <p className="font-semibold">
                                    {info.name}
                                  </p>
                                  {sp && (
                                    <p className="text-[11px] text-gray-300">
                                      Bat {sp.battingScore.toFixed(
                                        1
                                      )}
                                      {" · "}Bowl{" "}
                                      {sp.bowlingScore.toFixed(
                                        1
                                      )}
                                      {" · "}AR{" "}
                                      {sp.allRounderScore.toFixed(
                                        1
                                      )}
                                    </p>
                                  )}
                                </div>
                                <span className="text-[11px] text-gray-300">
                                  {formatAmount(
                                    info.priceLakhs,
                                    showInCrores
                                  )}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="text-gray-400">
                          No players bought yet.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto text-xs">
                {sets.length === 0 ? (
                  <p className="text-gray-400">
                    No sets generated yet.
                  </p>
                ) : (
                  <>
                    <p className="text-gray-400 mb-1">
                      Showing set{" "}
                      {(selectedSetIndex ?? 0) + 1} of{" "}
                      {sets.length}
                    </p>
                    <ul className="space-y-1">
                      {(
                        sets[selectedSetIndex ?? 0] || []
                      ).map((pid) => {
                        const sp =
                          scoredPlayers.find(
                            (p) => p.id === pid
                          ) ?? null;
                        const rp = players[pid];
                        const soldTeam =
                          rp?.soldToTeamId &&
                          teams[rp.soldToTeamId]
                            ? teams[rp.soldToTeamId]
                            : undefined;
                        return (
                          <li
                            key={pid}
                            className="flex justify-between items-center border border-gray-800 rounded px-2 py-1"
                          >
                            <div>
                              <p className="font-semibold">
                                {sp?.name ??
                                  rp?.name ??
                                  pid}
                              </p>
                              {sp && (
                                <p className="text-[11px] text-gray-300">
                                  Bat{" "}
                                  {sp.battingScore.toFixed(
                                    1
                                  )}
                                  {" · "}Bowl{" "}
                                  {sp.bowlingScore.toFixed(
                                    1
                                  )}
                                  {" · "}AR{" "}
                                  {sp.allRounderScore.toFixed(
                                    1
                                  )}
                                </p>
                              )}
                              {rp?.status === "sold" &&
                                soldTeam && (
                                  <p className="text-[11px] text-emerald-400">
                                    Sold to{" "}
                                    {soldTeam.name} for{" "}
                                    {formatAmount(
                                      rp.soldPriceLakhs,
                                      showInCrores
                                    )}
                                  </p>
                                )}
                              {rp?.status ===
                                "unsold" && (
                                <p className="text-[11px] text-red-400">
                                  Unsold
                                </p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
          </section>
        </section>
      )}

      {tab === "results" && (
        <section className="bg-gray-900 rounded p-4">
          <h2 className="text-lg font-semibold mb-3">
            Auction summary
          </h2>
          {allSoldPlayers.length === 0 ? (
            <p className="text-sm text-gray-400">
              No players sold yet.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-gray-300 border-b border-gray-700">
                <tr>
                  <th className="py-2 pr-3">Player</th>
                  <th className="py-2 pr-3">Team</th>
                  <th className="py-2 pr-3 text-right">
                    Price
                  </th>
                </tr>
              </thead>
              <tbody>
                {allSoldPlayers.map(([pid, p]) => {
                  const team =
                    p.soldToTeamId &&
                    teams[p.soldToTeamId]
                      ? teams[p.soldToTeamId]
                      : undefined;
                  return (
                    <tr
                      key={pid}
                      className="border-b border-gray-800 last:border-b-0"
                    >
                      <td className="py-1.5 pr-3">
                        {p.name}
                      </td>
                      <td className="py-1.5 pr-3">
                        {team ? team.name : "-"}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        {formatAmount(
                          p.soldPriceLakhs,
                          showInCrores
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
