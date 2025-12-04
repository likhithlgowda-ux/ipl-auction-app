"use client";

import { useState } from "react";
import Papa from "papaparse";
import { db } from "../../../lib/firebase";
import { ref, set } from "firebase/database";

type BattingRow = {
  Player?: string;
  Runs?: string | number;
  "Batting Average"?: string | number;
  "Batting Strike Rate"?: string | number;
  "4s"?: string | number;
  "6s"?: string | number;
};

type BowlingRow = {
  Player?: string;
  Wickets?: string | number;
  "Bowling Average"?: string | number;
  "Bowling Economy"?: string | number;
  "Bowling Strike Rate"?: string | number;
};

type MergedPlayer = {
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

function toNumber(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

export default function ImportStatsPage() {
  const [battingFile, setBattingFile] = useState<File | null>(null);
  const [bowlingFile, setBowlingFile] = useState<File | null>(null);
  const [mergedPlayers, setMergedPlayers] = useState<MergedPlayer[]>([]);
  const [status, setStatus] = useState<string>("Waiting for files...");
  const [season, setSeason] = useState<string>("2025");
  const [saving, setSaving] = useState(false);

  const handleParse = async () => {
    if (!battingFile || !bowlingFile) {
      setStatus("Please select both batting and bowling CSV files.");
      return;
    }

    setStatus("Parsing CSV files...");

    const parseCsv = (file: File): Promise<any[]> => {
      return new Promise((resolve, reject) => {
        Papa.parse(file, {
          header: true,
          dynamicTyping: false,
          skipEmptyLines: true,
          complete: (results) => {
            resolve(results.data as any[]);
          },
          error: (err) => reject(err)
        });
      });
    };

    try {
      const [batRowsRaw, bowlRowsRaw] = await Promise.all([
        parseCsv(battingFile),
        parseCsv(bowlingFile)
      ]);

      const batRows = batRowsRaw as BattingRow[];
      const bowlRows = bowlRowsRaw as BowlingRow[];

      const batMap = new Map<string, BattingRow>();
      batRows.forEach((row) => {
        const name = (row.Player || "").toString().trim();
        if (!name) return;
        batMap.set(name, row);
      });

      const bowlMap = new Map<string, BowlingRow>();
      bowlRows.forEach((row) => {
        const name = (row.Player || "").toString().trim();
        if (!name) return;
        bowlMap.set(name, row);
      });

      const allNames = new Set<string>([
        ...Array.from(batMap.keys()),
        ...Array.from(bowlMap.keys())
      ]);

      const merged: MergedPlayer[] = [];

      allNames.forEach((name) => {
        const bat = batMap.get(name);
        const bowl = bowlMap.get(name);

        const batting = {
          runs: toNumber(bat?.Runs),
          avg: toNumber(bat?.["Batting Average"]),
          sr: toNumber(bat?.["Batting Strike Rate"]),
          fours: toNumber(bat?.["4s"]),
          sixes: toNumber(bat?.["6s"])
        };

        const bowling = {
          wickets: toNumber(bowl?.Wickets),
          avg: toNumber(bowl?.["Bowling Average"]),
          econ: toNumber(bowl?.["Bowling Economy"]),
          sr: toNumber(bowl?.["Bowling Strike Rate"])
        };

        merged.push({ name, batting, bowling });
      });

      merged.sort((a, b) => a.name.localeCompare(b.name));

      setMergedPlayers(merged);
      setStatus(
        `Parsed season ${season}. Merged ${merged.length} players. Click "Save to Firebase" to store them.`
      );

      console.log("Merged players for season", season, merged);
    } catch (err) {
      console.error(err);
      setStatus("Error parsing files. Check console for details.");
    }
  };

  const handleSaveToFirebase = async () => {
    if (!season.trim()) {
      setStatus("Please enter a valid season (e.g. 2025).");
      return;
    }
    if (mergedPlayers.length === 0) {
      setStatus("No merged players to save. Parse the CSV files first.");
      return;
    }

    try {
      setSaving(true);
      setStatus(`Saving ${mergedPlayers.length} players to Firebase...`);

      // Convert array to an object keyed by a safe ID (index or slug).
      // Here we'll use numeric IDs based on index for simplicity.
      const playersObject: Record<string, any> = {};
      mergedPlayers.forEach((p, index) => {
        const id = `P${index + 1}`;
        playersObject[id] = {
          name: p.name,
          batting: p.batting,
          bowling: p.bowling
        };
      });

      const seasonRef = ref(db, `seasons/${season}/players`);
      await set(seasonRef, playersObject);

      setStatus(
        `Saved ${mergedPlayers.length} players to seasons/${season}/players in Firebase.`
      );
    } catch (err) {
      console.error(err);
      setStatus("Error saving to Firebase. Check console for details.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white p-4">
      <h1 className="text-2xl font-bold mb-4">Import IPL Stats (Admin)</h1>
      <p className="text-sm text-gray-400 mb-4">
        Upload batting and bowling CSV files for a season. First click
        &quot;Parse &amp; merge&quot; to combine them, then &quot;Save to
        Firebase&quot; to store them under seasons/&lt;season&gt;/players.
      </p>

      <section className="border border-gray-700 rounded p-4 mb-4 max-w-xl">
        <div className="mb-3">
          <label className="block text-sm mb-1">Season</label>
          <input
            type="text"
            value={season}
            onChange={(e) => setSeason(e.target.value)}
            className="px-2 py-1 rounded bg-gray-900 border border-gray-700 text-sm"
          />
        </div>

        <div className="mb-3">
          <label className="block text-sm mb-1">
            Batting CSV (e.g. ipl-2025-batting.csv)
          </label>
          <input
            type="file"
            accept=".csv"
            onChange={(e) => setBattingFile(e.target.files?.[0] || null)}
            className="text-sm"
          />
        </div>

        <div className="mb-3">
          <label className="block text-sm mb-1">
            Bowling CSV (e.g. ipl-2025-bowling.csv)
          </label>
          <input
            type="file"
            accept=".csv"
            onChange={(e) => setBowlingFile(e.target.files?.[0] || null)}
            className="text-sm"
          />
        </div>

        <div className="flex flex-wrap gap-2 mt-2">
          <button
            onClick={handleParse}
            className="px-4 py-2 bg-green-600 rounded disabled:bg-gray-600 text-sm"
            disabled={!battingFile || !bowlingFile}
          >
            Parse &amp; merge
          </button>
          <button
            onClick={handleSaveToFirebase}
            className="px-4 py-2 bg-blue-600 rounded disabled:bg-gray-600 text-sm"
            disabled={mergedPlayers.length === 0 || saving}
          >
            {saving ? "Saving..." : "Save to Firebase"}
          </button>
        </div>

        <p className="mt-3 text-sm text-gray-300">{status}</p>
      </section>

      <section className="max-w-xl">
        <h2 className="text-lg font-semibold mb-2">Preview (first 10 players)</h2>
        {mergedPlayers.length === 0 ? (
          <p className="text-sm text-gray-500">
            No data yet. Select both CSV files and click &quot;Parse &amp;
            merge&quot;.
          </p>
        ) : (
          <div className="text-xs bg-gray-900 rounded p-3 max-h-80 overflow-y-auto">
            {mergedPlayers.slice(0, 10).map((p, idx) => (
              <div
                key={p.name + idx.toString()}
                className="border-b border-gray-800 pb-1 mb-1"
              >
                <p className="font-semibold">{p.name}</p>
                <p className="text-gray-400">
                  Batting – Runs: {p.batting.runs}, Avg: {p.batting.avg}, SR:{" "}
                  {p.batting.sr}, 4s: {p.batting.fours}, 6s: {p.batting.sixes}
                </p>
                <p className="text-gray-400">
                  Bowling – Wkts: {p.bowling.wickets}, Avg: {p.bowling.avg},
                  Econ: {p.bowling.econ}, SR: {p.bowling.sr}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

