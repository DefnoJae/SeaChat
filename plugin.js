function init() {
  $ui.register((ctx) => {
    // build.mjs replaces this address for the shared public service.
    const base = "http://127.0.0.1:8787";
    const name = ctx.fieldRef("");
    const draft = ctx.fieldRef("");
    const reportId = ctx.fieldRef("");
    const messages = ctx.state([]);
    const status = ctx.state("Choose a display name to join the public room.");
    const joined = ctx.state(false);
    const busy = ctx.state(false);
    let token = "";
    let polling = false;
    let mounted = false;
    let cancelPoll = null;
    const view = ctx.newTray({
      iconUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23a78bfa' d='M4 3h16v14H8l-4 4V3zm3 4v2h10V7H7zm0 4v2h7v-2H7z'/%3E%3C/svg%3E",
      withContent: true, width: "480px", minHeight: "400px"
    });
    async function request(path, method, data) {
      const response = await ctx.fetch(base + path, {
        method: method || "GET",
        timeout: 10,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: data ? JSON.stringify(data) : undefined
      });
      const result = response.json();
      if (!response.ok) throw new Error(result.error || "Chat server unavailable.");
      return result;
    }
    async function refresh() {
      if (!token || polling) return;
      polling = true;
      try {
        const result = await request("/messages");
        messages.set(result.messages);
        status.set("Connected · Public room · Refreshes every 3 seconds");
      } catch (e) { status.set(String(e.message || e)); }
      finally { polling = false; }
    }
    const join = ctx.eventHandler("global-chat-join", async () => {
      if (busy.get()) return;
      busy.set(true);
      try {
        const result = await request("/sessions", "POST", { name: name.current });
        token = result.token;
        joined.set(true);
        await refresh();
        if (mounted && !cancelPoll) cancelPoll = ctx.setInterval(refresh, 3000);
      } catch (e) { status.set(String(e.message || e)); }
      finally { busy.set(false); }
    });
    const send = ctx.eventHandler("global-chat-send", async () => {
      if (busy.get() || !token) return;
      busy.set(true);
      try {
        await request("/messages", "POST", { text: draft.current });
        draft.setValue("");
        await refresh();
      } catch (e) { status.set(String(e.message || e)); }
      finally { busy.set(false); }
    });
    const report = ctx.eventHandler("global-chat-report", async () => {
      const id = String(reportId.current).trim();
      if (!/^\d+$/.test(id)) { status.set("Enter the message number to report."); return; }
      try {
        await request("/messages/" + id + "/report", "POST", {});
        status.set("Report sent to the room administrator.");
        reportId.setValue("");
      } catch (e) { status.set(String(e.message || e)); }
    });
    view.onOpen(() => {
      mounted = true;
      refresh();
      if (token && !cancelPoll) cancelPoll = ctx.setInterval(refresh, 3000);
    });
    view.onClose(() => { mounted = false; if (cancelPoll) cancelPoll(); cancelPoll = null; });
    view.render(() => {
      view.text("SeaChat · Global Chat", { style: { fontSize: "24px", fontWeight: "700" } });
      view.text("One room for everyone with this extension. Display names are unverified. Be kind; avoid spoilers and personal information.");
      view.text(status.get());
      if (!joined.get()) {
        view.input({ label: "Display name", placeholder: "2–24 characters", fieldRef: name });
        view.button({ label: "Join public room", onClick: join, loading: busy.get() });
      } else {
        view.div(messages.get().map(m => view.text("#" + m.id + " · " + m.name + " · " + m.createdAt + "\n" + m.text, { style: { whiteSpace: "pre-wrap", padding: "12px", borderBottom: "1px solid #444", overflowWrap: "anywhere" } })), { style: { maxHeight: "55vh", overflowY: "auto" } });
        view.input({ label: "Message", placeholder: "Up to 1000 characters", textarea: true, fieldRef: draft });
        view.button({ label: "Send", onClick: send, loading: busy.get() });
        view.input({ label: "Report a message", placeholder: "Message number", fieldRef: reportId });
        view.button({ label: "Report", onClick: report });
      }
    });
  });
}
