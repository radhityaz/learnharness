"use client";

import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import type { ArtifactPartProps, ImageSnapshot, ShowImageDetails } from "@/src/core";
import { useImageSnapshot } from "./use-image-snapshot";

/**
 * The show_image card (issue #363): one of the learner's own images, as
 * document material like a figure — the picture, then a caption row with
 * "Image" + the teacher's caption left and the controls right. No invert
 * switch (owner decision: a photo inverts to a negative). A failed or
 * still-running call keeps the quiet tool-call card.
 */

function isShowImageDetails(value: unknown): value is ShowImageDetails {
	const v = value as Partial<ShowImageDetails> | null | undefined;
	return (
		typeof v?.snapshotId === "string" &&
		/^[a-f0-9]{64}$/.test(v.snapshotId) &&
		(v.mimeType === "image/png" || v.mimeType === "image/jpeg") &&
		typeof v.path === "string" &&
		typeof v.width === "number" &&
		typeof v.height === "number"
	);
}

/** The learner's file name, without its directory. Pure. */
function baseName(path: string): string {
	return path.split(/[\\/]/).pop() || "image";
}

/** The download name: the file's stem with the STORED format's extension
 *  (a converted or shrunk image is no longer the original bytes). Pure. */
export function imageDownloadName(image: Pick<ShowImageDetails, "path" | "mimeType">): string {
	const stem = baseName(image.path).replace(/\.[^.]*$/, "") || "image";
	return `${stem}.${image.mimeType === "image/png" ? "png" : "jpg"}`;
}

/** The image as a standalone SVG document — the shape the fullscreen
 *  overlay (an SVG viewer, sized by viewBox) takes. Pure. */
export function imageSvgDocument(image: ImageSnapshot): string {
	const { width, height } = image;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image href="data:${image.mimeType};base64,${image.data}" width="${width}" height="${height}"/></svg>`;
}

export function ImageCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return <ToolCallCard part={part} />;
	const image = part.output;
	if (!isShowImageDetails(image)) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Image shown, but it could not be displayed.
			</div>
		);
	}
	return <StoredImageCard details={image} />;
}

/** Priming's course page (materi_page): same stored snapshot as show_image,
 *  shown at the column's full width so the slide text is readable, and
 *  labelled with its document and page instead of "Image". */
export function MateriPageCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return <ToolCallCard part={part} />;
	const image = part.output;
	if (!isShowImageDetails(image)) {
		// A refused or failed call carries no image: keep the quiet tool-call line.
		return <ToolCallCard part={part} />;
	}
	return <StoredImageCard details={image} variant="page" />;
}

/** "materi-inbox/x/Slide Kuliah/Week 3.pdf | p. 6" → { title: "Week 3", page: "6" }. Pure — exported for tests. */
export function materiPageLabel(path: string): { title: string; page: string | null } {
	const [doc = "", pagePart] = path.split(" | ");
	const parts = doc.split("/").filter(Boolean);
	// Old documents end in ".../<file>.pdf/markdown.md"; ingested ones in ".../<file>.pdf".
	const last = parts.at(-1) === "markdown.md" ? parts.at(-2) : parts.at(-1);
	const title = (last ?? doc).replace(/\.pdf$/i, "").replace(/ \[[0-9a-f]{6,}\]$/i, "").replace(/_/g, " ");
	const page = pagePart?.match(/(\d+)/)?.[1] ?? null;
	return { title, page };
}

function StoredImageCard({ details, variant = "figure" }: { details: ShowImageDetails; variant?: "figure" | "page" }) {
	const { image, failed } = useImageSnapshot(details.snapshotId);
	if (!image) return <div className="my-4 text-sm text-muted-foreground" role="status">{failed ? "Image snapshot could not be loaded." : "Loading image…"}</div>;
	return <ImagePresentation image={{ ...image, path: details.path, caption: details.caption }} variant={variant} />;
}

/** Resolved presentation shared by inline display, download and fullscreen. */
export function ImagePresentation({ image, variant = "figure" }: { image: ImageSnapshot & Pick<ShowImageDetails, "path" | "caption">; variant?: "figure" | "page" }) {
	const page = variant === "page" ? materiPageLabel(image.path) : null;
	const overlay = useSessionMermaid();
	const save = () => {
		const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
		downloadFile(imageDownloadName(image), bytes, image.mimeType);
	};
	return (
		/* Auto dimensions let the width/60vh constraints scale the whole picture
		   proportionally, never enlarge it. The wrapper hugs its displayed width;
		   w-0 + min-w-full keeps the caption from widening the card. */
		<figure className={page ? "my-4 w-full" : "my-4 mx-auto w-fit max-w-full"} data-testid={page ? "materi-page-card" : "image-card"}>
			<div className={page ? "w-full overflow-hidden rounded-lg" : "w-fit max-w-full overflow-hidden rounded-lg"}>
				{/* An in-memory image from the record; no Next image optimization. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src={`data:${image.mimeType};base64,${image.data}`}
					alt={image.caption ?? (page ? `${page.title}${page.page ? `, page ${page.page}` : ""}` : baseName(image.path))}
					width={image.width}
					height={image.height}
					// A course page is read, not glanced at: full column width,
					// no height cap (a portrait handout page would shrink to a stamp).
					className={page ? "block h-auto w-full" : "block h-auto w-auto max-h-[60vh] max-w-full"}
					draggable={false}
				/>
			</div>
			<figcaption className="mt-2 flex w-0 min-w-full items-start justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					{page ? (
						<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground" data-testid="materi-page-label" title={image.path}>
							{page.page ? `Page ${page.page}` : "Page"}
						</span>
					) : (
						<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Image</span>
					)}
					{page && <span className="min-w-0 truncate text-xs text-muted-foreground/80" title={image.path}>{page.title}</span>}
					{image.caption && (
						<span className="text-sm text-muted-foreground" data-testid="image-caption">
							{image.caption}
						</span>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<button
						type="button"
						aria-label="Download image"
						title="Download image"
						onClick={save}
						data-testid="image-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open image fullscreen"
							title="Open fullscreen"
							onClick={() => overlay.openFigure(imageSvgDocument(image), false)}
							data-testid="image-open"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</figcaption>
		</figure>
	);
}
