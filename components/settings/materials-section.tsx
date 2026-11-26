"use client";

import { useEffect, useState } from "react";
import { formatDollars, type AgentSettings, type VoyageSpend } from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

/**
 * Settings → Course materials: the Priming switch plus a read-only view of
 * the materi index (what each course holds, where to drop new PDFs, the last
 * ingest outcomes). Status comes from GET /api/materi/status (local files
 * only); the switch writes agent.priming through the shared agent writer.
 */

interface CourseStatus {
	matkul: string;
	chunks: number;
	documents: number;
	withPages: number;
}

interface IngestLine {
	at: string;
	file: string;
	status: "ingested" | "duplicate" | "skipped" | "failed";
	pages?: number;
	ocrPages?: number;
	note?: string;
}

interface MaterialsStatus {
	installed: boolean;
	problem?: string;
	courses: CourseStatus[];
	inbox: string;
	recent: IngestLine[];
	voyage?: VoyageSpend;
}

/** One line per model: "voyage-4-large · 12,345 tokens · $0.0015 list, free allowance left". Pure — exported for tests. */
export function voyageLine(m: VoyageSpend["models"][number]): string {
	const tokens = `${m.tokens.toLocaleString("en-US")} tokens`;
	if (m.listDollars === null) return `${m.model} · ${tokens} · unpriced`;
	const billed = m.billedDollars && m.billedDollars > 0 ? `billed ${formatDollars(m.billedDollars)}` : "within the free allowance";
	return `${m.model} · ${tokens} · ${formatDollars(m.listDollars)} at list price, ${billed}`;
}

/** "matkul-mr4062-manajemen-proyek" → "MR4062 Manajemen Proyek". Pure — exported for tests. */
export function courseLabel(matkul: string): string {
	const [code, ...rest] = matkul.replace(/^matkul-/, "").split("-");
	// Roman numerals stay upper case ("Tugas Akhir ... I"); other words get a capital.
	const name = rest.map((w) => (/^(i|ii|iii|iv|v|vi)$/.test(w) ? w.toUpperCase() : (w[0]?.toUpperCase() ?? "") + w.slice(1))).join(" ");
	return [code?.toUpperCase(), name].filter(Boolean).join(" ");
}

/** Compose the Priming switch into the agent section. Pure — exported for tests. */
export function composePriming(agent: AgentSettings | undefined, on: boolean): AgentSettings {
	return { ...agent, priming: { enabled: on } };
}

const STATUS_LABEL: Record<IngestLine["status"], string> = {
	ingested: "Added",
	duplicate: "Already indexed",
	skipped: "Skipped",
	failed: "Failed",
};

function fileName(file: string): string {
	return file.split("/").pop() ?? file;
}

function when(at: string): string {
	const d = new Date(at);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function MaterialsSection({
	agent,
	onSectionChange,
}: {
	agent: AgentSettings | undefined;
	onSectionChange: (next: AgentSettings) => unknown;
}) {
	const [status, setStatus] = useState<MaterialsStatus | null | undefined>(undefined);
	useEffect(() => {
		let alive = true;
		fetch("/api/materi/status")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((s: MaterialsStatus) => alive && setStatus(s))
			.catch(() => alive && setStatus(null));
		return () => {
			alive = false;
		};
	}, []);

	const installed = status?.installed === true;
	const totalDocs = status?.courses.reduce((n, c) => n + c.documents, 0) ?? 0;

	return (
		<>
			<SettingsGroup label="Priming" testid="group-priming">
				<SettingsRow
					label="Start Teach sessions with Priming"
					hint={
						status === undefined
							? "Checking your course materials…"
							: installed
								? "Before any question, the tutor walks you through the original pages of your course materials"
								: "Needs indexed course materials (none found)"
					}
					testid="priming-row"
					dimmed={status !== undefined && !installed}
				>
					<Toggle
						checked={agent?.priming?.enabled ?? true}
						disabled={!installed}
						label="priming"
						onChange={(on) => onSectionChange(composePriming(agent, on))}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="Indexed courses" testid="group-courses">
				{status === undefined && <p className="text-xs text-muted-foreground">Loading…</p>}
				{status === null && <p className="text-xs text-error">Course materials status could not be loaded.</p>}
				{status && !installed && (
					<p className="text-xs text-muted-foreground">{status.problem ?? "No course materials are indexed yet."}</p>
				)}
				{status && installed && (
					<>
						<p className="text-xs text-muted-foreground">
							{status.courses.length} course{status.courses.length === 1 ? "" : "s"}, {totalDocs} document{totalDocs === 1 ? "" : "s"}
						</p>
						<table className="w-full text-sm" data-testid="materials-courses">
							<thead>
								<tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
									<th className="py-1 font-normal">Course</th>
									<th className="py-1 text-right font-normal">Documents</th>
									<th className="py-1 text-right font-normal">Pages shown in Priming</th>
								</tr>
							</thead>
							<tbody>
								{status.courses.map((c) => (
									<tr key={c.matkul} className="border-t border-border/40">
										<td className="py-1.5 pr-2" title={c.matkul}>{courseLabel(c.matkul)}</td>
										<td className="py-1.5 text-right tabular-nums">{c.documents}</td>
										<td className={`py-1.5 text-right tabular-nums ${c.withPages < c.documents ? "font-medium" : "text-muted-foreground"}`}>
											{c.withPages === c.documents ? "All" : `${c.withPages} of ${c.documents}`}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}
			</SettingsGroup>

			{status && (
				<SettingsGroup label="Adding material" testid="group-inbox">
					<p className="text-xs text-muted-foreground">
						Drop a PDF, Word or PowerPoint file into a course folder inside the inbox; it is indexed within a few minutes while
						LearnHarness runs (Word and PowerPoint are converted to PDF with LibreOffice or Microsoft Office). Pages already
						indexed are skipped, and only pages without a text layer are sent to OCR. For a password-protected PDF, put the
						password in a text file named like the PDF plus <code>.password</code> next to it.
					</p>
					<code className="block break-all rounded-md bg-muted px-2 py-1.5 text-xs" data-testid="materials-inbox">
						{status.inbox}
						{/[\\]/.test(status.inbox) ? "\\" : "/"}&lt;course&gt;
					</code>
					{status.recent.length > 0 && (
						<p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">Recent</p>
					)}
					{status.recent.length > 0 && (
						<ul className="flex flex-col gap-1 text-xs" data-testid="materials-recent">
							{status.recent.map((r, i) => (
								<li key={`${r.at}-${i}`} className="flex items-baseline justify-between gap-3">
									<span className="min-w-0 truncate" title={r.note ?? r.file}>
										<span className={r.status === "failed" ? "text-error" : "text-muted-foreground"}>{STATUS_LABEL[r.status]}</span>{" "}
										{fileName(r.file)}
										{r.pages ? <span className="text-muted-foreground"> · {r.pages} pages{r.ocrPages ? `, ${r.ocrPages} OCR` : ""}</span> : null}
									</span>
									<span className="shrink-0 text-muted-foreground/70">{when(r.at)}</span>
								</li>
							))}
						</ul>
					)}
				</SettingsGroup>
			)}

			{status?.voyage && (
				<SettingsGroup label="Search spend (Voyage)" testid="group-voyage">
					{status.voyage.calls === 0 ? (
						<p className="text-xs text-muted-foreground">No Voyage calls recorded yet.</p>
					) : (
						<>
							<p className="text-xs text-muted-foreground" data-testid="voyage-total">
								{status.voyage.calls.toLocaleString("en-US")} calls since {when(status.voyage.since ?? "")}:{" "}
								{formatDollars(status.voyage.listDollars)} at list price, billed {formatDollars(status.voyage.billedDollars)}.
								Each model has a one-time free allowance of 200M tokens per account.
							</p>
							<ul className="flex flex-col gap-1 text-xs" data-testid="voyage-models">
								{status.voyage.models.map((m) => (
									<li key={m.model} className="tabular-nums">{voyageLine(m)}</li>
								))}
							</ul>
						</>
					)}
				</SettingsGroup>
			)}
		</>
	);
}
