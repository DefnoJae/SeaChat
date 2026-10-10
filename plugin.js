function init() {
  $ui.register((ctx) => {
    const base = "http://127.0.0.1:8787";
    const content = "__SEACHAT_WEBVIEW__";
    let token = $storage.get("sessionToken") || "";
    let revision = "", mounted = false, fetching = false, busy = false, cancelPoll = null;
    const avatars = new Map();
    const state = ctx.state({ joined: false, busy: false, connected: false, profile: null, messages: [], status: "", notice: "", noticeId: 0, success: "" });
    function update(values) { state.set(Object.assign({}, state.get(), values)); }
    const panel = ctx.newWebview({ slot: "fixed", width: "460px", maxWidth: "calc(100vw - 24px)", height: "640px", maxHeight: "calc(100vh - 32px)", hidden: true, zIndex: 100, window: { defaultPosition: "bottom-right", frameless: true } });
    const tray = ctx.newTray({ tooltipText: "SeaChat", withContent: false, iconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23a78bfa' d='M4 3h16v14H8l-4 4V3zm3 4v2h10V7H7zm0 4v2h7v-2H7z'/%3E%3C/svg%3E" });
    panel.channel.sync("chat", state);
    panel.setContent(() => content);
    async function request(path, method, data) {
      const response = await ctx.fetch(base + path, { method: method || "GET", timeout: 15, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: data === undefined ? undefined : JSON.stringify(data) });
      const result = response.json();
      if (!response.ok) throw Object.assign(new Error(result.error || "Chat server unavailable."), { status: response.status });
      return result;
    }
    function notice(error) { update({ notice: String(error.message || error), noticeId: state.get().noticeId + 1 }); }
    async function refresh() {
      if (!token || fetching) return;
      fetching = true;
      try {
        const result = await request("/messages" + (revision ? "?revision=" + encodeURIComponent(revision) : ""));
        if (result.messages) {
          const unique = new Map();
          result.messages.forEach(m => { if (m.avatarVersion) unique.set(m.userId, m.avatarVersion); });
          for (const [id, version] of unique) {
            const key = id + ":" + version;
            if (!avatars.has(key)) {
              try { const image = await request("/avatars/" + id); if (image.avatarVersion === version) avatars.set(key, image.avatar); } catch {}
            }
          }
          const keys = new Set(Array.from(unique, ([id, v]) => id + ":" + v));
          for (const key of avatars.keys()) if (!keys.has(key)) avatars.delete(key);
          update({ messages: result.messages.map(m => Object.assign({}, m, { avatar: avatars.get(m.userId + ":" + m.avatarVersion) || "" })) });
        }
        revision = result.revision || ""; update({ connected: true, status: "" });
      } catch (e) { update({ connected: false, status: String(e.message || e) }); }
      finally { fetching = false; }
    }
    async function resume() {
      if (!token) return;
      try { const profile = await request("/profile"); update({ joined: true, profile }); await refresh(); }
      catch (e) { if (e.status === 401) { token = ""; $storage.remove("sessionToken"); update({ joined: false, profile: null }); } notice(e); }
      if (mounted && token && !cancelPoll) cancelPoll = ctx.setInterval(refresh, 10000);
    }
    async function action(kind, fn) {
      if (busy) return;
      busy = true; update({ busy: true, notice: "", success: "" });
      try { await fn(); update({ busy: false, success: kind }); } catch (e) { notice(e); }
      finally { busy = false; update({ busy: false }); }
    }
    panel.channel.on("join", data => action("join", async () => {
      const result = await request("/sessions", "POST", { name: data.name });
      token = result.token; $storage.set("sessionToken", token); revision = ""; await resume();
    }));
    panel.channel.on("send", data => action("send", async () => { await request("/messages", "POST", { text: data.text }); await refresh(); }));
    panel.channel.on("profile", data => action("profile", async () => {
      const profile = await request("/profile", "PUT", { name: data.name, color: data.color, avatar: data.avatar });
      update({ profile }); revision = ""; await refresh();
    }));
    panel.channel.on("report", data => action("report", async () => {
      if (!Number.isSafeInteger(data.messageId) || data.messageId < 1) throw new Error("Select a message.");
      await request("/messages/" + data.messageId + "/report", "POST", { reason: data.reason, details: data.details });
    }));
    function close() { mounted = false; if (cancelPoll) cancelPoll(); cancelPoll = null; panel.hide(); }
    panel.channel.on("close", close);
    tray.onClick(() => { if (mounted) close(); else { mounted = true; panel.show(); resume(); } });
    panel.onMount(() => { if (mounted) resume(); });
    panel.onUnmount(() => { mounted = false; if (cancelPoll) cancelPoll(); cancelPoll = null; });
    panel.channel.on("ready", () => update({}));
  });
}
