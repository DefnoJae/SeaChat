function init() {
  $ui.register((ctx) => {
    const base = "http://127.0.0.1:8787";
    const content = "__SEACHAT_WEBVIEW__";
    let token = $storage.get("sessionToken") || "";
    let revision = "", mounted = false, pollPending = false, busy = false, cancelPoll = null;
    let queue = Promise.resolve(), latestMessages = [], replyCursor = 0, cursorKey = "";
    let readCursor = 0, readKey = "", firstVisit = false, identityReady = false, nextClosedPoll = 0, failures = 0;
    const avatars = new Map();
    const state = ctx.state({ joined: false, visible: false, busy: false, connected: false, profile: null, messages: [], unreadReplies: [], activity: null, openSequence: 0, initialTarget: null, contextId: null, jumpId: null, jumpSequence: 0, status: "", notice: "", noticeId: 0, success: "", successId: 0 });
    function update(values) { state.set(Object.assign({}, state.get(), values)); }
    function serial(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
    const panel = ctx.newWebview({ slot: "fixed", width: "460px", maxWidth: "max(1px, calc(100vw - 100px))", height: "min(640px, calc(100vh - 32px))", maxHeight: "calc(100vh - 32px)", style: "left:84px;top:50%;transform:translateY(-50%)", hidden: true, zIndex: 100, window: { draggable: false, frameless: true } });
    const tray = ctx.newTray({ tooltipText: "SeaChat", withContent: false, iconUrl: "https://raw.githubusercontent.com/DefnoJae/SeaChat/main/assets/icon.png" });
    function setActivity(activity) {
      if (!activity) return;
      update({ activity });
      tray.updateBadge({ number: activity.unreadCount || 0, intent: "info" });
    }
    async function prepareIdentity() {
      const profile = await request("/profile");
      readKey = "messageRead:" + base + ":" + profile.userId;
      cursorKey = "replyRead:" + base + ":" + profile.userId;
      const saved = $storage.get(readKey), savedReply = $storage.get(cursorKey);
      firstVisit = !Number.isSafeInteger(saved) || saved < 0;
      readCursor = firstVisit ? 0 : saved;
      replyCursor = Number.isSafeInteger(savedReply) && savedReply >= 0 ? savedReply : 0;
      if (firstVisit) {
        const activity = await request("/activity?after=0");
        readCursor = activity.latestId; $storage.set(readKey, readCursor);
      }
      identityReady = true;
      if (profile.avatarVersion) avatars.set(profile.userId + ":" + profile.avatarVersion, profile.avatar);
      update({ joined: true, profile });
    }
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
        const result = await request("/messages?after=" + readCursor + (revision ? "&revision=" + encodeURIComponent(revision) : ""));
        if (result.messages) latestMessages = result.messages;
        revision = result.revision || "";
        setActivity(result.activity);
        if (!mounted) return;
        let visible = latestMessages;
        const contextId = state.get().contextId;
        if (contextId !== null) {
          try { visible = (await request("/messages/context/" + contextId)).messages; }
          catch (e) { if (e.status !== 404) throw e; update({ contextId: null }); notice(e); }
        }
        // Hydrate on quiet polls too, allowing failed avatar requests to recover.
        const hydrated = await hydrate(visible);
        if (!mounted) return;
        update({ messages: hydrated, connected: true, status: "" });
        const replies = await request("/replies?after=" + replyCursor);
        if (mounted) update({ unreadReplies: replies.replies });
        failures = 0;
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
        if (!identityReady) await prepareIdentity();
        update({ contextId: null }); await refreshNow();
        if (!mounted) return;
        const target = firstVisit ? -1 : state.get().activity?.oldestUnreadId || null;
        if (target && target > 0 && !latestMessages.some(m => m.id === target)) {
          try { const result = await request("/messages/context/" + target); update({ messages: await hydrate(result.messages), contextId: target }); }
          catch (e) { if (e.status !== 404) throw e; }
        }
        firstVisit = false;
        update({ visible: true, initialTarget: target, openSequence: state.get().openSequence + 1 });
      } catch (e) { if (e.status === 401) { token = ""; $storage.remove("sessionToken"); update({ joined: false, profile: null }); } notice(e); }
      startPolling();
    }
    function startPolling() {
      if (!token || cancelPoll) return;
      cancelPoll = ctx.setInterval(() => {
        if (mounted) return refresh();
        if (pollPending || Date.now() < nextClosedPoll) return;
        pollPending = true;
        return serial(async () => {
          try {
            if (!identityReady) await prepareIdentity();
            setActivity(await request("/activity?after=" + readCursor)); failures = 0;
          } catch (e) {
            failures++;
            if (e.status === 401 || e.status === 403) { token = ""; identityReady = false; tray.updateBadge({ number: 0 }); if (cancelPoll) cancelPoll(); cancelPoll = null; }
          } finally { nextClosedPoll = Date.now() + Math.min(300000, 30000 * Math.pow(2, failures)); }
        }).finally(() => { pollPending = false; });
      }, 10000);
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
      token = result.token; identityReady = false; $storage.set("sessionToken", token); revision = ""; latestMessages = []; await resumeNow();
    }));
    panel.channel.on("send", data => action("send", async () => {
      await request("/messages", "POST", { text: data.text, attachment: data.attachment || null, replyToId: data.replyToId == null ? null : data.replyToId });
      update({ contextId: null }); await refreshNow();
    }));
    panel.channel.on("profile", data => action("profile", async () => {
      const profile = await request("/profile", "PUT", { name: data.name, color: data.color, avatar: data.avatar });
      avatars.set(profile.userId + ":" + profile.avatarVersion, profile.avatar);
      const apply = m => m.userId === profile.userId ? Object.assign({}, m, { name: profile.name, color: profile.color, avatar: profile.avatar, avatarVersion: profile.avatarVersion }) : m;
      latestMessages = latestMessages.map(apply);
      update({ profile, messages: state.get().messages.map(apply) }); revision = ""; await refreshNow();
    }));
    for (const kind of ["edit", "delete"]) panel.channel.on(kind, data => action(kind, async () => {
      if (!Number.isSafeInteger(data.messageId) || data.messageId < 1) throw new Error("Select a message.");
      await request("/messages/" + data.messageId, kind === "edit" ? "PATCH" : "DELETE", kind === "edit" ? { text: data.text } : undefined);
      revision = ""; await refreshNow();
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
    panel.channel.on("readMessages", data => serial(async () => {
      const max = latestMessages.length ? latestMessages[latestMessages.length - 1].id : 0;
      if (!mounted || state.get().contextId !== null || !readKey || !Number.isSafeInteger(data.messageId) || data.messageId <= readCursor || data.messageId > max) return;
      readCursor = data.messageId; $storage.set(readKey, readCursor);
      setActivity(await request("/activity?after=" + readCursor));
    }).catch(notice));
    function close() { mounted = false; update({ visible: false }); panel.hide(); nextClosedPoll = Date.now(); }
    panel.channel.on("close", close);
    tray.onClick(() => { if (mounted) close(); else { mounted = true; panel.show(); serial(resumeNow); } });
    panel.onMount(() => { if (mounted) serial(() => { if (!state.get().visible) return resumeNow(); }); else startPolling(); });
    panel.onUnmount(() => { mounted = false; if (cancelPoll) cancelPoll(); cancelPoll = null; });
    panel.channel.on("media", async data => {
      if(!Number.isSafeInteger(data.requestId))return;
      try { const result=await request('/media','POST',{kind:data.kind,query:data.query,page:data.page,action:data.action,id:data.id});update({mediaResponse:{requestId:data.requestId,result}}); }
      catch(e){update({mediaResponse:{requestId:data.requestId,error:String(e.message)}});}
    });
    panel.channel.on("ready", () => update({}));
    startPolling();
  });
}
