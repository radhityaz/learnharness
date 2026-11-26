"use client";

import { useEffect, useState } from "react";
import { onSettingsSaved } from "@/components/settings-signal";

/**
 * Will a new Teach session open with Priming? True when a materi index is
 * installed and the Priming switch is on (GET /api/materi/status). One
 * request per page load; an agent-section save (the switch lives there)
 * refreshes it.
 */

let cached: Promise<boolean> | null = null;

function load(): Promise<boolean> {
	cached ??= fetch("/api/materi/status")
		.then((r) => (r.ok ? r.json() : null))
		.then((s: { installed?: boolean; priming?: boolean } | null) => Boolean(s?.installed && s.priming))
		.catch(() => false);
	return cached;
}

export function usePrimingAvailable(): boolean {
	const [available, setAvailable] = useState(false);
	useEffect(() => {
		let alive = true;
		const refresh = () => void load().then((v) => alive && setAvailable(v));
		refresh();
		const unsubscribe = onSettingsSaved((section) => {
			if (section !== "agent") return;
			cached = null;
			refresh();
		});
		return () => {
			alive = false;
			unsubscribe();
		};
	}, []);
	return available;
}

export const TEACH_OPENING = {
	priming: "The teacher will open with your course pages, then probe what you already know.",
	probe: "The teacher will open by probing what you already know.",
} as const;
