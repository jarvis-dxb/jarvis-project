import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
// The web process reads the cache; all WhatsApp network operations stay in the worker.
export class WhatsAppConnection {
    options;
    clients = new Map();
    pending = new Map();
    refreshing = new Map();
    timers = new Map();
    generations = new Map();
    retries = new Map();
    root;
    constructor(options) {
        this.options = options;
        this.root = resolve(options.sessionRoot);
        const publicRoot = resolve("./public");
        if (this.root === publicRoot || this.root.startsWith(publicRoot + sep))
            throw new Error("WA_SESSION_ROOT cannot be public");
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }
    folder(workspace) { return join(this.root, createHash("sha256").update(workspace).digest("hex")); }
    hasSession(workspace) { return existsSync(join(this.folder(workspace), "creds.json")); }
    connected(workspace) {
        const client = this.clients.get(workspace);
        return client?.ready ? client.socket : undefined;
    }
    clearTimer(workspace) {
        clearTimeout(this.timers.get(workspace));
        this.timers.delete(workspace);
    }
    retry(workspace) {
        this.clearTimer(workspace);
        const attempt = (this.retries.get(workspace) || 0) + 1;
        this.retries.set(workspace, attempt);
        const timer = setTimeout(() => {
            this.timers.delete(workspace);
            void this.connect(workspace).catch(() => { });
        }, Math.min(60000, 5000 * 2 ** Math.min(attempt - 1, 4)));
        timer.unref();
        this.timers.set(workspace, timer);
    }
    removeSession(workspace) {
        const target = resolve(this.folder(workspace));
        if (!target.startsWith(this.root + sep))
            throw new Error("Unsafe session path");
        rmSync(target, { recursive: true, force: true });
        this.options.groups(workspace, []);
    }
    connect(workspace) {
        if (this.pending.has(workspace))
            return this.pending.get(workspace);
        if (this.clients.has(workspace))
            return Promise.resolve();
        this.clearTimer(workspace);
        const generation = (this.generations.get(workspace) || 0) + 1;
        this.generations.set(workspace, generation);
        const current = () => (this.generations.get(workspace) || 0) === generation;
        const task = (async () => {
            this.options.status(workspace, "connecting");
            mkdirSync(this.folder(workspace), { recursive: true, mode: 0o700 });
            const opened = await this.options.open(this.folder(workspace));
            if (!current()) {
                opened.socket.end(new Error("Connection cancelled"));
                return;
            }
            const client = { ...opened, ready: false, writes: Promise.resolve() };
            this.clients.set(workspace, client);
            const active = () => current() && this.clients.get(workspace) === client;
            client.socket.ev.on("creds.update", () => {
                if (active())
                    client.writes = client.writes.then(client.saveCreds).catch(() => {
                        if (active())
                            this.options.status(workspace, client.ready ? "connected" : "error", { number: this.number(client), error: "Unable to save WhatsApp session. Check session directory access." });
                    });
            });
            client.socket.ev.on("connection.update", (update) => {
                if (!active())
                    return;
                if (update.qr)
                    this.options.status(workspace, "qr_ready", { qr: update.qr });
                if (update.connection === "open") {
                    this.retries.delete(workspace);
                    client.ready = true;
                    this.options.status(workspace, "connected", { number: this.number(client) });
                    void this.refreshGroups(workspace).catch(() => { });
                }
                if (update.connection === "close") {
                    client.ready = false;
                    this.clients.delete(workspace);
                    this.refreshing.delete(workspace);
                    const error = update.lastDisconnect?.error;
                    const loggedOut = (error?.output?.statusCode || error?.data?.statusCode) === 401; // Baileys DisconnectReason.loggedOut
                    this.options.status(workspace, loggedOut ? "logged_out" : "reconnecting", { error: loggedOut ? "WhatsApp session was logged out. Link the device again." : "Connection interrupted. Reconnecting automatically…" });
                    if (loggedOut) {
                        void client.writes.then(() => { if (current() && !this.clients.has(workspace))
                            this.removeSession(workspace); });
                    }
                    else
                        this.retry(workspace);
                }
            });
        })().catch(() => {
            if (current()) {
                this.options.status(workspace, "reconnecting", { error: "Unable to connect to WhatsApp. Retrying automatically…" });
                this.retry(workspace);
            }
            throw new Error("Unable to connect to WhatsApp; automatic retry scheduled");
        }).finally(() => { if (this.pending.get(workspace) === task)
            this.pending.delete(workspace); });
        this.pending.set(workspace, task);
        return task;
    }
    number(client) { return String(client.socket.user?.id || "").split(":")[0].split("@")[0]; }
    refreshGroups(workspace) {
        if (this.refreshing.has(workspace))
            return this.refreshing.get(workspace);
        const client = this.clients.get(workspace);
        if (!client?.ready)
            return Promise.reject(new Error("Connect WhatsApp to load its groups."));
        const task = (async () => {
            const result = await client.socket.groupFetchAllParticipating();
            if (this.clients.get(workspace) !== client || !client.ready)
                return 0;
            const groups = Object.values(result).filter((group) => /^\d+(?:-\d+)?@g\.us$/.test(group.id))
                .map((group) => ({ jid: group.id, name: String(group.subject || group.id).slice(0, 120) }))
                .sort((a, b) => a.name.localeCompare(b.name));
            this.options.groups(workspace, groups);
            this.options.status(workspace, "connected", { number: this.number(client) });
            return groups.length;
        })().catch(() => {
            if (this.clients.get(workspace) === client && client.ready)
                this.options.status(workspace, "connected", { number: this.number(client), error: "Connected, but groups could not be loaded. Use Refresh groups to retry." });
            throw new Error("Groups could not be loaded. Use Refresh groups to retry.");
        }).finally(() => { if (this.refreshing.get(workspace) === task)
            this.refreshing.delete(workspace); });
        this.refreshing.set(workspace, task);
        return task;
    }
    async logout(workspace) {
        this.retries.delete(workspace);
        this.generations.set(workspace, (this.generations.get(workspace) || 0) + 1);
        this.clearTimer(workspace);
        const client = this.clients.get(workspace);
        this.clients.delete(workspace);
        const pending = this.pending.get(workspace);
        try {
            await client?.socket.logout();
        }
        catch {
            client?.socket.end(new Error("Manual disconnect"));
        }
        await pending?.catch(() => { });
        await client?.writes;
        this.refreshing.delete(workspace);
        this.removeSession(workspace);
        this.options.status(workspace, "logged_out");
    }
    async close() {
        const pendingWrites = Array.from(this.clients.values()).map(client => client.writes);
        for (const workspace of new Set([...this.clients.keys(), ...this.pending.keys(), ...this.timers.keys()])) {
            this.generations.set(workspace, (this.generations.get(workspace) || 0) + 1);
            this.clearTimer(workspace);
            this.clients.get(workspace)?.socket.end(new Error("Worker stopped"));
            this.options.status(workspace, "disconnected");
        }
        this.clients.clear();
        await Promise.allSettled(pendingWrites);
    }
}
