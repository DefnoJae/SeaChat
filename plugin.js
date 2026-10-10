function init() {
  $ui.register((ctx) => {
    const base = "http://127.0.0.1:8787";
    const content = "__SEACHAT_WEBVIEW__";
    let token = $storage.get("sessionToken") || "";
    let revision = "", mounted = false, pollPending = false, busy = false, cancelPoll = null;
    let queue = Promise.resolve(), latestMessages = [], replyCursor = 0, cursorKey = "";
    const avatars = new Map();
    const state = ctx.state({ joined: false, busy: false, connected: false, profile: null, messages: [], unreadReplies: [], contextId: null, jumpId: null, jumpSequence: 0, status: "", notice: "", noticeId: 0, success: "", successId: 0 });
    function update(values) { state.set(Object.assign({}, state.get(), values)); }
    function serial(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
    const panel = ctx.newWebview({ slot: "fixed", width: "460px", maxWidth: "max(1px, calc(100vw - 100px))", height: "min(640px, calc(100vh - 32px))", maxHeight: "calc(100vh - 32px)", style: "left:84px;top:50%;transform:translateY(-50%)", hidden: true, zIndex: 100, window: { draggable: false, frameless: true } });
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
    async function hydrate(messages) {
      const unique = new Map();
      messages.forEach(m => { if (m.avatarVersion) unique.set(m.userId, m.avatarVersion); });
      for (const [id, version] of unique) {
        const key = id + ":" + version;
        if (!avatars.has(key)) {
          try { const image = await request("/avatars/" + id); if (image.avatarVersion === version) avatars.set(key, image.avatar); } catch {}
        }
      }
      const keys = new Set(Array.from(unique, ([id, v]) => id + ":" + v));
      for (const key of avatars.keys()) if (!keys.has(key)) avatars.delete(key);
      const profile = state.get().profile;
      return messages.map(m => Object.assign({}, m, { avatar: avatars.get(m.userId + ":" + m.avatarVersion) || "" },
        profile && m.userId === profile.userId ? { name: profile.name, color: profile.color, avatar: profile.avatar, avatarVersion: profile.avatarVersion } : {}));
    }
    async function refreshNow() {
      if (!token) return;
      try {
        const result = await request("/messages" + (revision ? "?revision=" + encodeURIComponent(revision) : ""));
        if (result.messages) latestMessages = result.messages;
        revision = result.revision || "";
        let visible = latestMessages;
        const contextId = state.get().contextId;
        if (contextId !== null) {
          try { visible = (await request("/messages/context/" + contextId)).messages; }
          catch (e) { if (e.status !== 404) throw e; update({ contextId: null }); notice(e); }
        }
        // Hydrate on quiet polls too, allowing failed avatar requests to recover.
        update({ messages: await hydrate(visible), connected: true, status: "" });
        const replies = await request("/replies?after=" + replyCursor);
        update({ unreadReplies: replies.replies });
      } catch (e) { update({ connected: false, status: String(e.message || e) }); }
    }
    function refresh() {
      if (!mounted || !token || pollPending) return;
      pollPending = true;
      return serial(async () => { if (mounted) await refreshNow(); }).finally(() => { pollPending = false; });
    }
    async function resumeNow() {
      if (!token || !mounted) return;
      try {
        const profile = await request("/profile");
        cursorKey = "replyRead:" + base + ":" + profile.userId;
        const saved = $storage.get(cursorKey);
        replyCursor = Number.isSafeInteger(saved) && saved >= 0 ? saved : 0;
        if (profile.avatarVersion) avatars.set(profile.userId + ":" + profile.avatarVersion, profile.avatar);
        update({ joined: true, profile }); await refreshNow();
      } catch (e) { if (e.status === 401) { token = ""; $storage.remove("sessionToken"); update({ joined: false, profile: null }); } notice(e); }
      if (mounted && token && !cancelPoll) cancelPoll = ctx.setInterval(refresh, 10000);
    }
    function action(kind, fn) {
      if (busy) return;
      busy = true; update({ busy: true, notice: "", success: "" });
      return serial(async () => {
        try { await fn(); update({ busy: false, success: kind, successId: state.get().successId + 1 }); }
        catch (e) { notice(e); }
        finally { busy = false; update({ busy: false }); }
      });
    }
    panel.channel.on("join", data => action("join", async () => {
      const result = await request("/sessions", "POST", { name: data.name });
      token = result.token; $storage.set("sessionToken", token); revision = ""; latestMessages = []; await resumeNow();
    }));
    panel.channel.on("send", data => action("send", async () => {
      await request("/messages", "POST", { text: data.text, replyToId: data.replyToId == null ? null : data.replyToId });
      update({ contextId: null }); await refreshNow();
    }));
    panel.channel.on("profile", data => action("profile", async () => {
      const profile = await request("/profile", "PUT", { name: data.name, color: data.color, avatar: data.avatar });
      avatars.set(profile.userId + ":" + profile.avatarVersion, profile.avatar);
      const apply = m => m.userId === profile.userId ? Object.assign({}, m, { name: profile.name, color: profile.color, avatar: profile.avatar, avatarVersion: profile.avatarVersion }) : m;
      latestMessages = latestMessages.map(apply);
      update({ profile, messages: state.get().messages.map(apply) }); revision = ""; await refreshNow();
    }));
    panel.channel.on("report", data => action("report", async () => {
      if (!Number.isSafeInteger(data.messageId) || data.messageId < 1) throw new Error("Select a message.");
      await request("/messages/" + data.messageId + "/report", "POST", { reason: data.reason, details: data.details });
    }));
    async function jump(id) {
      if (!state.get().messages.some(m => m.id === id)) {
        const result = await request("/messages/context/" + id);
        update({ messages: await hydrate(result.messages), contextId: id });
      }
      update({ jumpId: id, jumpSequence: state.get().jumpSequence + 1 });
    }
    panel.channel.on("jump", data => action("jump", async () => {
      if (!Number.isSafeInteger(data.messageId) || data.messageId < 1) throw new Error("Invalid message.");
      await jump(data.messageId);
    }));
    panel.channel.on("readReply", () => action("readReply", async () => {
      const reply = state.get().unreadReplies[0]; if (!reply) return;
      try { await jump(reply.id); }
      catch (e) { if (e.status !== 404) throw e; notice(e); }
      replyCursor = reply.id; $storage.set(cursorKey, replyCursor);
      update({ unreadReplies: state.get().unreadReplies.filter(r => r.id > replyCursor) });
    }));
    panel.channel.on("readAll", () => {
      if (busy || !cursorKey || !state.get().unreadReplies.length) return;
      replyCursor = state.get().unreadReplies[state.get().unreadReplies.length - 1].id;
      $storage.set(cursorKey, replyCursor); update({ unreadReplies: [] });
    });
    panel.channel.on("latest", () => action("latest", async () => { update({ contextId: null }); await refreshNow(); update({ jumpId: null, jumpSequence: state.get().jumpSequence + 1 }); }));
    function close() { mounted = false; if (cancelPoll) cancelPoll(); cancelPoll = null; panel.hide(); }
    panel.channel.on("close", close);
    tray.onClick(() => { if (mounted) close(); else { mounted = true; panel.show(); serial(resumeNow); } });
    panel.onMount(() => { if (mounted) serial(resumeNow); });
    panel.onUnmount(() => { mounted = false; if (cancelPoll) cancelPoll(); cancelPoll = null; });
    panel.channel.on("ready", () => update({}));
  });
}
