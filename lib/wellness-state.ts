import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { REMINDERS, wellnessDeadline, type Reminder, type WellnessConfig } from "./shell-wellness.ts";

const VERSION = 1;
const DIRECTORY = "gentle-wellness-state";
const REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WellnessReminderState {
	deadline: number;
	revision: string;
}
export interface WellnessState {
	version: 1;
	reminders: Record<Reminder, WellnessReminderState>;
}
interface PersistedReminder extends WellnessReminderState {
	version: 1;
	reminder: Reminder;
}
type ReadResult =
	| { status: "valid"; value: PersistedReminder }
	| { status: "missing" | "invalid" };
interface WellnessStateStoreOptions {
	/** Test-only seam for deterministic claim interleavings. */
	beforeClaimCreate?: () => void | Promise<void>;
}
function parseReminder(key: Reminder, value: unknown): PersistedReminder | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (input.version !== VERSION || input.reminder !== key || !Number.isSafeInteger(input.deadline) || Number(input.deadline) < 0 ||
		typeof input.revision !== "string" || !REVISION.test(input.revision)) return undefined;
	return input as unknown as PersistedReminder;
}
function snapshot(records: Record<Reminder, PersistedReminder>): WellnessState {
	return {
		version: VERSION,
		reminders: Object.fromEntries(REMINDERS.map((key) => [key, {
			deadline: records[key].deadline,
			revision: records[key].revision,
		}])) as Record<Reminder, WellnessReminderState>,
	};
}

/** Independent atomic reminder records and exclusive, revision-scoped notice claims. */
export class WellnessStateStore {
	readonly path: string;
	private readonly directory: string;
	private readonly config: WellnessConfig;
	private readonly beforeClaimCreate?: () => void | Promise<void>;
	constructor(directory: string, config: WellnessConfig, options: WellnessStateStoreOptions = {}) {
		this.directory = join(directory, DIRECTORY);
		this.path = this.directory;
		this.config = config;
		this.beforeClaimCreate = options.beforeClaimCreate;
	}
	async load(): Promise<WellnessState | undefined> {
		const records = {} as Record<Reminder, PersistedReminder>;
		for (const key of REMINDERS) {
			const result = await this.readRecord(key);
			if (result.status !== "valid") return undefined;
			records[key] = result.value;
		}
		return snapshot(records);
	}
	async loadOrInitialize(now: number): Promise<WellnessState | undefined> {
		if (!await this.ensureDirectory()) return undefined;
		const records = {} as Record<Reminder, PersistedReminder>;
		for (const key of REMINDERS) {
			let result = await this.readRecord(key);
			if (result.status === "invalid") return undefined;
			if (result.status === "missing") {
				const created: PersistedReminder = {
					version: VERSION, reminder: key,
					deadline: wellnessDeadline(this.config, key, now), revision: randomUUID(),
				};
				if (!await this.initializeRecord(key, created)) return undefined;
				result = await this.readRecord(key);
			}
			if (result.status !== "valid") return undefined;
			records[key] = result.value;
		}
		for (const key of REMINDERS) await this.pruneClaims(key, records[key].revision);
		return snapshot(records);
	}
	async reset(target: string, now: number): Promise<WellnessState | undefined> {
		if (target !== "all" && !REMINDERS.includes(target as Reminder)) return undefined;
		const records = {} as Record<Reminder, PersistedReminder>;
		for (const key of REMINDERS) {
			const result = await this.readRecord(key);
			if (result.status !== "valid") return undefined;
			records[key] = result.value;
		}
		for (const key of REMINDERS) if (target === "all" || target === key) {
			const updated: PersistedReminder = {
				version: VERSION, reminder: key,
				deadline: wellnessDeadline(this.config, key, now), revision: randomUUID(),
			};
			if (!await this.publishRecord(key, updated)) return undefined;
			records[key] = updated;
			await this.pruneClaims(key, updated.revision);
		}
		return snapshot(records);
	}
	async claimDue(key: Reminder, revision: string, now: number): Promise<boolean> {
		if (!REMINDERS.includes(key) || !REVISION.test(revision)) return false;
		const result = await this.readRecord(key);
		if (result.status !== "valid" || result.value.revision !== revision || result.value.deadline > now) return false;
		await this.beforeClaimCreate?.();
		let handle;
		try {
			handle = await open(join(this.directory, `.claim-${key}-${revision}`), "wx", 0o600);
			await handle.close();
			const current = await this.readRecord(key);
			return current.status === "valid" && current.value.revision === revision && current.value.deadline <= now;
		} catch {
			try { await handle?.close(); } catch { /* Claims remain fail-closed. */ }
			return false;
		}
	}
	private recordPath(key: Reminder): string { return join(this.directory, `${key}.json`); }
	/** A claim only guards its own revision, and claimDue rejects any revision
	 * that is no longer current, so claims for superseded revisions are dead.
	 * The current revision's claim is kept: removing it would allow a repeat. */
	private async pruneClaims(key: Reminder, currentRevision: string): Promise<void> {
		const prefix = `.claim-${key}-`;
		let names: string[];
		try { names = await readdir(this.directory); } catch { return; }
		for (const name of names) {
			if (!name.startsWith(prefix) || name === `${prefix}${currentRevision}`) continue;
			try { await unlink(join(this.directory, name)); } catch { /* Cleanup is best effort. */ }
		}
	}
	private async ensureDirectory(): Promise<boolean> {
		try {
			await mkdir(this.directory, { mode: 0o700 });
			return true;
		} catch (error) { return (error as NodeJS.ErrnoException).code === "EEXIST"; }
	}
	private async readRecord(key: Reminder): Promise<ReadResult> {
		try {
			const parsed = parseReminder(key, JSON.parse(await readFile(this.recordPath(key), "utf8")));
			return parsed ? { status: "valid", value: parsed } : { status: "invalid" };
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing" } : { status: "invalid" };
		}
	}
	private async initializeRecord(key: Reminder, record: PersistedReminder): Promise<boolean> {
		const temporary = await this.writeTemporary(key, record);
		if (!temporary) return false;
		try { await link(temporary, this.recordPath(key)); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code === "EEXIST"; }
		finally { try { await unlink(temporary); } catch { /* Unpublished temporary cleanup. */ } }
	}
	private async publishRecord(key: Reminder, record: PersistedReminder): Promise<boolean> {
		const temporary = await this.writeTemporary(key, record);
		if (!temporary) return false;
		try { await rename(temporary, this.recordPath(key)); return true; }
		catch {
			try { await unlink(temporary); } catch { /* Unpublished temporary cleanup. */ }
			return false;
		}
	}
	private async writeTemporary(key: Reminder, record: PersistedReminder): Promise<string | undefined> {
		const path = join(this.directory, `.${key}.${record.revision}.tmp`);
		let handle;
		try { handle = await open(path, "wx", 0o600); } catch { return undefined; }
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			return path;
		} catch {
			try { await handle.close(); } catch { /* Continue cleanup. */ }
			try { await unlink(path); } catch { /* Nothing published. */ }
			return undefined;
		}
	}
}
