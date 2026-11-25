import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { materiPageLabel } from "../components/artifacts/image-card.tsx";
import { composePriming, courseLabel } from "../components/settings/materials-section.tsx";
import { primingEnabled, resolveSettings } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";

describe("course materials: settings and labels", () => {
	it("priming defaults ON and follows the stored switch", () => {
		assert.equal(primingEnabled(resolveSettings(null)), true);
		assert.equal(primingEnabled(resolveSettings({ version: 1, agent: { priming: {} } })), true);
		assert.equal(primingEnabled(resolveSettings({ version: 1, agent: { priming: { enabled: false } } })), false);
	});

	it("the read side drops a malformed switch instead of turning priming off", () => {
		const bad = sanitizeUserSettings({ version: 1, agent: { priming: { enabled: "no" } } });
		assert.equal(bad?.agent?.priming, undefined);
		const off = sanitizeUserSettings({ version: 1, agent: { priming: { enabled: false } } });
		assert.deepEqual(off?.agent?.priming, { enabled: false });
	});

	it("composePriming keeps the rest of the agent section", () => {
		assert.deepEqual(composePriming({ tools: { pdf: false } }, false), { tools: { pdf: false }, priming: { enabled: false } });
		assert.deepEqual(composePriming(undefined, true), { priming: { enabled: true } });
	});

	it("courseLabel turns a course id into its code and name", () => {
		assert.equal(courseLabel("matkul-mr4062-manajemen-proyek"), "MR4062 Manajemen Proyek");
		assert.equal(courseLabel("matkul-ti4091-tugas-akhir-teknik-industri-i"), "TI4091 Tugas Akhir Teknik Industri I");
		assert.equal(courseLabel("other"), "OTHER");
	});

	it("materiPageLabel names the document and page for both id shapes", () => {
		assert.deepEqual(materiPageLabel("materi-inbox/matkul-x/Slide Kuliah/manajemen proyek-week 3.pdf | p. 6"), {
			title: "manajemen proyek-week 3",
			page: "6",
		});
		assert.deepEqual(materiPageLabel("materi/matkul-x/Buku/Project_Management [9fefbf55].pdf/markdown.md | p. 127"), {
			title: "Project Management",
			page: "127",
		});
		assert.deepEqual(materiPageLabel("plain.png"), { title: "plain.png", page: null });
	});
});
