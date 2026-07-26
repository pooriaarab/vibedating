/**
 * The local web app, as a single self-contained HTML string.
 *
 * Adapted from `docs/prototype.html`: identical visual design, but the data is no
 * longer random — the page reads your locally-computed league + matches from
 * `/api/state` and connects via `/api/connect` (both served from this machine by
 * `src/server.ts`). Raw usage is shown only behind a local toggle.
 *
 * Served as-is by the local HTTP server; not exported for library consumers.
 */
export const webAppHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>vibedating — matched by how hard you push the model</title>
<style>
  :root{
    --bg: #1a1120;
    --bg-1: #22162a;
    --bg-card: #2a1b33;
    --bg-card-2: #31203c;
    --fg: #f8efe8;
    --muted: #cbb2c4;
    --muted-2: #a88fae;
    --border: rgba(248,239,232,0.09);
    --border-2: rgba(248,239,232,0.15);
    --coral: #ff7a68;
    --coral-dim: #e26456;
    --amber: #ffb15e;
    --mint: #7fe3c0;
    --danger: #ff6b6f;
    --lg-1m: #d69a6e;
    --lg-5m: #cfd8e6;
    --lg-10m: #ffcf6b;
    --lg-100m: #f0839c;
    --lg-1b: #cba8ff;
    --shadow-1: 0 1px 2px rgba(0,0,0,.35);
    --shadow-2: 0 18px 40px -20px rgba(0,0,0,.65);
    --shadow-3: 0 30px 70px -28px rgba(0,0,0,.7);
    --radius: 20px;
    --ease-out: cubic-bezier(.16,1,.3,1);
    --ease-bounce: cubic-bezier(.34,1.56,.64,1);
    --dur-fast: .18s;
    --dur-med: .42s;
    --dur-slow: .9s;
  }

  @media (prefers-reduced-motion: reduce){
    *, *::before, *::after{
      animation-duration: .001s !important;
      animation-iteration-count: 1 !important;
      transition-duration: .001s !important;
      scroll-behavior: auto !important;
    }
  }

  *{ box-sizing: border-box; }
  html,body{ margin:0; padding:0; }
  body{
    background:
      radial-gradient(1100px 640px at 14% -6%, rgba(255,122,104,.14), transparent 60%),
      radial-gradient(900px 560px at 92% 8%, rgba(203,168,255,.10), transparent 55%),
      var(--bg);
    color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  ::selection{ background: rgba(255,122,104,.35); }
  .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

  a, button{ font: inherit; color: inherit; }
  button{ cursor:pointer; }
  :focus-visible{ outline: 2px solid var(--mint); outline-offset: 2px; border-radius: 6px; }

  header.topbar{
    position: sticky; top:0; z-index: 40;
    display:flex; align-items:center; justify-content:space-between; gap:16px;
    padding: 16px 24px;
    background: rgba(26,17,32,.78);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    border-bottom: 1px solid var(--border);
  }
  .wordmark{ display:flex; align-items:baseline; gap:10px; }
  .wordmark .name{ font-size: 1.25rem; font-weight: 800; letter-spacing: -0.02em; }
  .wordmark .name span{ color: var(--coral); }
  .wordmark .tag{ font-size: .82rem; color: var(--muted); font-weight: 500; }
  .local-badge{
    display:inline-flex; align-items:center; gap:8px;
    padding: 7px 13px 7px 10px;
    border-radius: 999px;
    background: rgba(127,227,192,.09);
    border: 1px solid rgba(127,227,192,.28);
    font-size: .78rem; font-weight: 600; color: #bff2df;
    white-space: nowrap;
  }
  .local-badge .dot{
    width:7px; height:7px; border-radius:50%;
    background: var(--mint);
    box-shadow: 0 0 0 3px rgba(127,227,192,.18);
    animation: pulse-dot 2.4s ease-in-out infinite;
    flex-shrink:0;
  }
  @keyframes pulse-dot{
    0%,100%{ transform: scale(1); opacity:1; }
    50%{ transform: scale(1.35); opacity:.65; }
  }

  .hero{ max-width: 1240px; margin: 0 auto; padding: 44px 24px 8px; }
  .hero h1{
    font-size: clamp(1.8rem, 3.6vw, 2.9rem);
    line-height: 1.08; letter-spacing: -0.03em; font-weight: 800;
    max-width: 20ch; margin: 0 0 10px;
  }
  .hero p{
    color: var(--muted); font-size: 1.02rem; max-width: 56ch; margin:0;
    line-height: 1.5;
  }

  .stage{
    max-width: 1240px; margin: 0 auto; padding: 30px 24px 100px;
    display: grid;
    grid-template-columns: minmax(280px,336px) minmax(320px,404px) minmax(268px,320px);
    gap: 26px;
    align-items: start;
  }
  @media (max-width: 1020px){
    .stage{ grid-template-columns: 1fr; max-width: 620px; }
  }

  .panel{ opacity: 0; transform: translateY(16px); }
  .loaded .panel{ animation: rise var(--dur-slow) var(--ease-out) forwards; }
  .loaded .panel:nth-of-type(1){ animation-delay: .02s; }
  .loaded .panel:nth-of-type(2){ animation-delay: .12s; }
  .loaded .panel:nth-of-type(3){ animation-delay: .22s; }
  @keyframes rise{ to{ opacity:1; transform: translateY(0); } }

  h2.panel-title{
    font-size: 1.02rem; font-weight: 700; margin: 0 0 14px;
    display:flex; align-items:center; gap:8px;
  }

  .card{
    background: linear-gradient(180deg, var(--bg-card), var(--bg-card-2));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    padding: 22px;
  }

  .avatar{
    width: 76px; height:76px; border-radius: 50%;
    overflow: hidden; flex-shrink:0;
    background: var(--bg-1);
    border: 1px solid var(--border-2);
    box-shadow: var(--shadow-1);
  }
  .avatar svg{ width:100%; height:100%; display:block; }

  .connect-head{ display:flex; align-items:center; gap:14px; margin-bottom: 16px; }
  .connect-head .who .h{ font-weight: 700; font-size: 1rem; }
  .connect-head .who .s{ color: var(--muted); font-size: .85rem; }

  .provider-picker{
    display:flex; gap:6px; padding:4px; border-radius: 12px;
    background: rgba(0,0,0,.22); border: 1px solid var(--border); margin-bottom: 14px;
  }
  .provider-picker button{
    flex:1; border:0; background: transparent; color: var(--muted);
    padding: 9px 8px; border-radius: 9px; font-size: .84rem; font-weight: 600;
    transition: background var(--dur-fast) ease, color var(--dur-fast) ease;
  }
  .provider-picker button.is-active{
    background: var(--bg-card); color: var(--fg);
    box-shadow: var(--shadow-1);
  }

  .btn{
    border:0; border-radius: 13px; padding: 13px 18px; font-weight: 700; font-size: .92rem;
    display:inline-flex; align-items:center; justify-content:center; gap:8px;
    width:100%;
    transition: transform var(--dur-fast) var(--ease-out), filter var(--dur-fast) ease, box-shadow var(--dur-fast) ease;
  }
  .btn:active{ transform: scale(.97); }
  .btn-primary{
    background: linear-gradient(180deg, var(--coral), var(--coral-dim));
    color: #2a1109;
    box-shadow: 0 12px 24px -12px rgba(255,122,104,.55);
  }
  .btn-primary:hover{ filter: brightness(1.06); }
  .btn-ghost{
    background: transparent; color: var(--muted); border: 1px solid var(--border-2);
  }
  .btn-ghost:hover{ color: var(--fg); border-color: var(--muted-2); }
  .btn:disabled{ opacity:.45; cursor: not-allowed; filter:none; box-shadow:none; }

  .step{ display:none; }
  .step.is-active{ display:block; animation: fadein var(--dur-med) var(--ease-out); }
  @keyframes fadein{ from{ opacity:0; transform: translateY(4px);} to{ opacity:1; transform:none; } }

  .consent-box{
    background: rgba(0,0,0,.22); border: 1px solid var(--border-2);
    border-radius: 14px; padding: 14px 16px; margin-bottom: 14px;
  }
  .consent-box .lead{ font-size: .86rem; font-weight: 700; margin-bottom: 10px; }
  .consent-line{ display:flex; gap:8px; align-items:flex-start; font-size: .82rem; color: var(--muted); margin-bottom:7px; line-height:1.4; }
  .consent-line:last-child{ margin-bottom:0; }
  .consent-line .yes{ color: var(--mint); flex-shrink:0; }
  .consent-line .no{ color: var(--muted-2); flex-shrink:0; }
  .consent-actions{ display:flex; gap:10px; margin-top: 14px; }

  .verify-box .lead{ font-size: .86rem; font-weight: 700; margin-bottom: 12px; display:flex; align-items:center; gap:10px; }
  .spinner{
    width:16px; height:16px; border-radius:50%;
    border: 2px solid rgba(255,177,94,.25); border-top-color: var(--amber);
    animation: spin .8s linear infinite; flex-shrink:0;
  }
  @keyframes spin{ to{ transform: rotate(360deg); } }
  .progress-track{
    height:6px; border-radius: 999px; background: rgba(0,0,0,.3); overflow:hidden; margin-bottom:10px;
  }
  .progress-fill{
    height:100%; width:0%; border-radius:999px;
    background: linear-gradient(90deg, var(--amber), var(--coral));
    transition: width 1.7s var(--ease-out);
  }
  .verify-step-text{ font-size:.8rem; color: var(--muted); min-height: 1.2em; }

  .error-box{
    background: rgba(255,107,111,.08); border: 1px solid rgba(255,107,111,.3);
    border-radius: 14px; padding: 14px 16px; margin-bottom:14px;
  }
  .error-box .lead{ font-size:.86rem; font-weight:700; color:#ffb3b6; margin-bottom:6px; }
  .error-box p{ font-size: .82rem; color: var(--muted); margin: 0 0 12px; line-height:1.45; }

  .reveal-top{ display:flex; gap:14px; align-items:center; margin-bottom: 16px; }
  .reveal-top .handle{ font-weight:700; }
  .verified-line{ font-size:.78rem; color: var(--mint); display:flex; align-items:center; gap:5px; margin-top:3px; }

  .raw-counter{ font-size: .84rem; color: var(--muted); margin-bottom: 4px; min-height: 1.2em; }
  .raw-counter .n{ color: var(--amber); }

  .league-badge-wrap{ display:flex; justify-content:center; margin: 6px 0 16px; }
  .league-badge{
    display:inline-flex; align-items:center; gap:9px;
    padding: 12px 20px;
    border-radius: 16px;
    font-weight: 800; font-size: 1.05rem;
    transform: scale(.4); opacity:0;
  }
  .league-badge.is-in{ animation: badge-in .6s var(--ease-bounce) forwards; }
  @keyframes badge-in{ to{ transform: scale(1); opacity:1; } }
  .league-badge .crest{ width:22px; height:22px; flex-shrink:0; }

  .traits{ display:flex; flex-wrap:wrap; gap:7px; margin-bottom: 14px; }
  .trait{
    font-size: .76rem; font-weight:600; padding: 6px 11px; border-radius: 999px;
    background: rgba(248,239,232,.06); border: 1px solid var(--border-2); color: var(--muted);
    opacity:0; transform: translateY(6px);
  }
  .trait.is-in{ animation: trait-in var(--dur-med) var(--ease-out) forwards; }
  @keyframes trait-in{ to{ opacity:1; transform:none; } }

  .raw-toggle{
    background:none; border:0; color: var(--muted-2); font-size:.76rem; font-weight:600;
    text-decoration: underline; text-underline-offset:2px; padding:2px 0;
  }
  .raw-toggle:hover{ color: var(--muted); }
  .raw-reveal{
    max-height:0; overflow:hidden; transition: max-height var(--dur-med) var(--ease-out);
    font-size: .78rem; color: var(--muted-2);
  }
  .raw-reveal.is-open{ max-height: 60px; margin-top:8px; }

  .stack-wrap{ position: relative; height: 430px; }
  .card-stack{ position:absolute; inset:0; }
  .match-card{
    position:absolute; inset:0;
    background: linear-gradient(165deg, var(--bg-card), var(--bg-card-2));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    padding: 20px;
    display:flex; flex-direction:column;
    transition: transform var(--dur-med) var(--ease-out), opacity var(--dur-med) ease;
  }
  .match-card[data-depth="0"]{ z-index:3; }
  .match-card[data-depth="1"]{ z-index:2; transform: translateY(14px) scale(.96); opacity:.85; }
  .match-card[data-depth="2"]{ z-index:1; transform: translateY(26px) scale(.92); opacity:.55; }
  .match-card.fly-like{ transform: translate(140%, -30px) rotate(18deg) !important; opacity:0 !important; }
  .match-card.fly-pass{ transform: translate(-140%, -30px) rotate(-18deg) !important; opacity:0 !important; }

  .mc-top{ display:flex; gap:12px; align-items:center; }
  .mc-avatar{ width:58px; height:58px; border-radius:50%; overflow:hidden; flex-shrink:0; border:1px solid var(--border-2); background:var(--bg-1); }
  .mc-avatar svg{ width:100%; height:100%; display:block; transition: transform .5s var(--ease-out); }
  .match-card:hover .mc-avatar svg{ transform: rotate(8deg) scale(1.05); }
  .mc-handle{ font-weight:700; font-size:.98rem; }
  .mc-league{
    display:inline-flex; align-items:center; gap:5px; font-size:.72rem; font-weight:700;
    padding: 4px 9px; border-radius:999px; margin-top:4px;
  }
  .mc-verified{ font-size:.7rem; color:var(--mint); display:flex; align-items:center; gap:4px; margin-top:5px; }

  .mc-bio{ margin-top:16px; flex:1; }
  .mc-bio p{ font-size:.87rem; color: var(--muted); line-height:1.5; margin: 0 0 8px; }

  .mc-actions{ display:flex; gap:10px; margin-top: 12px; }
  .round-btn{
    width:52px; height:52px; border-radius:50%; border:1px solid var(--border-2);
    background: rgba(0,0,0,.18); font-size:1.3rem;
    display:flex; align-items:center; justify-content:center;
    transition: transform var(--dur-fast) var(--ease-bounce), background var(--dur-fast) ease, border-color var(--dur-fast) ease;
  }
  .round-btn:hover:not(:disabled){ transform: translateY(-3px); }
  .round-btn:active:not(:disabled){ transform: scale(.9); }
  .round-btn.pass:hover:not(:disabled){ border-color: var(--muted-2); }
  .round-btn.like:hover:not(:disabled){ border-color: var(--coral); background: rgba(255,122,104,.12); }
  .round-btn:disabled{ opacity:.35; cursor: not-allowed; }
  .mc-actions .hint{ align-self:center; font-size:.76rem; color: var(--muted-2); margin-left:2px; }

  .empty-state{
    position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center;
    text-align:center; padding: 30px;
    background: linear-gradient(165deg, var(--bg-card), var(--bg-card-2));
    border: 1px dashed var(--border-2); border-radius: var(--radius);
  }
  .empty-state p{ color: var(--muted); font-size:.88rem; max-width: 30ch; margin: 8px 0 16px; line-height:1.5; }
  .empty-state strong{ font-size:1rem; }

  .celebrate{
    position: fixed; inset:0; z-index: 60;
    display:flex; align-items:center; justify-content:center;
    background: rgba(12,7,15,.6);
    backdrop-filter: blur(6px);
    opacity:0; pointer-events:none;
    transition: opacity var(--dur-med) ease;
  }
  .celebrate.is-open{ opacity:1; pointer-events:auto; }
  .celebrate-card{
    background: linear-gradient(165deg, var(--bg-card), var(--bg-card-2));
    border: 1px solid var(--border-2); border-radius: 24px; box-shadow: var(--shadow-3);
    padding: 34px 30px; max-width: 340px; text-align:center;
    transform: scale(.85) translateY(10px); transition: transform var(--dur-med) var(--ease-bounce);
  }
  .celebrate.is-open .celebrate-card{ transform: scale(1) translateY(0); }
  .celebrate-avatars{ display:flex; justify-content:center; gap:-10px; margin-bottom:14px; }
  .celebrate-avatars .avatar{ width:56px; height:56px; margin: 0 -8px; border-width:2px; border-color: var(--bg-card-2); }
  .celebrate h3{ margin: 4px 0 6px; font-size:1.25rem; font-weight:800; }
  .celebrate p{ color: var(--muted); font-size:.88rem; margin: 0 0 18px; line-height:1.5; }

  .ladder-row{
    display:flex; align-items:center; gap:10px; padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .ladder-row:last-child{ border-bottom:0; }
  .ladder-label{ width:64px; flex-shrink:0; font-size:.78rem; font-weight:700; }
  .ladder-bar-track{ flex:1; height:9px; border-radius:999px; background: rgba(0,0,0,.28); overflow:hidden; }
  .ladder-bar-fill{
    height:100%; border-radius:999px; width:0%;
    transition: width 1.1s var(--ease-out);
  }
  .ladder-pool{ width:64px; flex-shrink:0; text-align:right; font-size:.72rem; color: var(--muted-2); }
  .you-marker{
    display:inline-flex; align-items:center; gap:4px; font-size:.66rem; font-weight:800;
    color: #2a1109; background: var(--mint); padding: 2px 7px; border-radius:999px;
    margin-left:6px; opacity:0; transform: translateX(-4px);
  }
  .you-marker.is-in{ animation: you-in var(--dur-med) var(--ease-out) forwards; }
  @keyframes you-in{ to{ opacity:1; transform:none; } }

  .ladder-note{ font-size:.78rem; color: var(--muted-2); line-height:1.5; margin: 14px 0 0; padding-top:14px; border-top: 1px solid var(--border); }

  .explainer-chip{
    width:100%; text-align:left; background: rgba(0,0,0,.18); border: 1px solid var(--border-2);
    border-radius: 14px; padding: 13px 15px; margin-top: 18px;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    font-weight:700; font-size:.86rem;
  }
  .explainer-chip:hover{ border-color: var(--muted-2); }
  .explainer-chip .chevron{ transition: transform var(--dur-fast) var(--ease-out); color: var(--muted-2); }
  .explainer-chip[aria-expanded="true"] .chevron{ transform: rotate(180deg); }
  .explainer-panel{
    max-height:0; overflow:hidden; transition: max-height var(--dur-med) var(--ease-out);
  }
  .explainer-panel.is-open{ max-height: 260px; }
  .explainer-panel .inner{ padding: 13px 4px 2px; font-size:.84rem; color: var(--muted); line-height:1.55; }
  .explainer-panel .inner b{ color: var(--fg); }

  footer.foot{
    max-width:1240px; margin: 0 auto; padding: 0 24px 50px; color: var(--muted-2); font-size:.76rem;
  }

  @media (max-width: 480px){
    .hero{ padding: 32px 18px 4px; }
    .stage{ padding: 22px 18px 80px; }
    header.topbar{ padding: 13px 16px; flex-wrap: wrap; }
  }
</style>
</head>
<body>

<header class="topbar">
  <div class="wordmark">
    <span class="name">vibe<span>dating</span></span>
    <span class="tag">matched by how hard you push the model</span>
  </div>
  <div class="local-badge"><span class="dot" aria-hidden="true"></span> raw usage stays local &middot; only league shared</div>
</header>

<div class="hero">
  <h1>Heavy users of the same tools share something. Let's find out what.</h1>
  <p>Connect your Claude Code or Codex usage, get sorted into a league by volume, and match with people who burn tokens the way you do.</p>
</div>

<main class="stage" id="stage">

  <section class="panel" aria-label="Your profile">
    <h2 class="panel-title">Your profile</h2>
    <div class="card">

      <div class="step is-active" data-step="idle">
        <div class="connect-head">
          <div class="avatar" id="idleAvatar"></div>
          <div class="who">
            <div class="h">You</div>
            <div class="s">Not connected yet</div>
          </div>
        </div>
        <div class="provider-picker" role="group" aria-label="Choose provider">
          <button type="button" class="is-active" data-harness="claude-code">Claude Code</button>
          <button type="button" data-harness="codex">Codex</button>
        </div>
        <button class="btn btn-primary" id="btnConnect" type="button">Connect Claude / Codex</button>
      </div>

      <div class="step" data-step="consent">
        <div class="connect-head">
          <div class="avatar" id="consentAvatar"></div>
          <div class="who">
            <div class="h">You</div>
            <div class="s" id="consentProviderLabel">Connecting Claude Code...</div>
          </div>
        </div>
        <div class="consent-box">
          <div class="lead">vibedating is requesting:</div>
          <div class="consent-line"><span class="yes">&#10003;</span> Read-only usage history &mdash; token counts, time-of-day patterns</div>
          <div class="consent-line"><span class="no">&#10007;</span> Your prompts, code, or conversation content</div>
          <div class="consent-line"><span class="no">&#10007;</span> Your password &mdash; auth happens in your CLI's own OAuth flow</div>
          <div class="consent-line"><span class="no">&#10007;</span> Any write access, ever</div>
        </div>
        <div class="consent-actions">
          <button class="btn btn-ghost" id="btnCancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="btnAuthorize" type="button">Authorize read-only</button>
        </div>
      </div>

      <div class="step" data-step="verifying">
        <div class="verify-box">
          <div class="lead"><span class="spinner" aria-hidden="true"></span> Reading your usage...</div>
          <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
          <div class="verify-step-text mono" id="verifyStepText" role="status" aria-live="polite">Reading local usage...</div>
        </div>
      </div>

      <div class="step" data-step="error">
        <div class="error-box">
          <div class="lead">Couldn't read usage</div>
          <p>The local usage read failed. Nothing was shared either way &mdash; no prompts, no partial numbers, nothing.</p>
        </div>
        <button class="btn btn-primary" id="btnRetry" type="button">Try again</button>
      </div>

      <div class="step" data-step="reveal">
        <div class="reveal-top">
          <div class="avatar" id="revealAvatar"></div>
          <div class="who">
            <div class="h" id="revealHandle">@you</div>
            <div class="verified-line" id="verifiedLine"><span>&#10003;</span> usage read locally</div>
          </div>
        </div>

        <div class="raw-counter mono" id="rawCounter" aria-live="polite">aggregating usage...</div>

        <div class="league-badge-wrap">
          <div class="league-badge" id="leagueBadge"></div>
        </div>

        <div class="traits" id="traitsRow"></div>

        <button class="raw-toggle" id="rawToggle" type="button" aria-expanded="false">show raw usage (visible only to you)</button>
        <div class="raw-reveal mono" id="rawReveal">-</div>

        <div style="margin-top:14px;">
          <button class="btn btn-ghost" id="btnReset" type="button">Disconnect &amp; reset</button>
        </div>
      </div>

    </div>
  </section>

  <section class="panel" aria-label="Match stack">
    <h2 class="panel-title">Match stack</h2>
    <div class="stack-wrap">
      <div class="card-stack" id="cardStack"></div>
    </div>
  </section>

  <section class="panel" aria-label="League ladder">
    <h2 class="panel-title">League ladder</h2>
    <div class="card">
      <div id="ladderRows"></div>
      <p class="ladder-note">Pool math gets thin fast above 100M &mdash; up at 1B+ you might be choosing from single digits. We're not hiding that; it's the honest tradeoff of matching on something this specific.</p>

      <button class="explainer-chip" id="explainerBtn" type="button" aria-expanded="false" aria-controls="explainerPanel">
        <span>Why leagues?</span>
        <span class="chevron" aria-hidden="true">&#9662;</span>
      </button>
      <div class="explainer-panel" id="explainerPanel">
        <div class="inner">
          Because the number has to be <b>real</b>. Matching on "heavy user" only means something if the usage behind it is yours &mdash; so vibedating reads it from your own machine. <b>Raw token counts never leave this device</b>; only your league bucket is ever shared. In v0 the pool is a local seeded demo; verification via read-only OAuth is the next step.
        </div>
      </div>
    </div>
  </section>

</main>

<footer class="foot">Local-first. Your league is computed from usage read on this machine and stored here only &mdash; raw usage never leaves your device.</footer>

<div class="celebrate" id="celebrate" role="dialog" aria-modal="true" aria-live="polite">
  <div class="celebrate-card">
    <div class="celebrate-avatars">
      <div class="avatar" id="celebrateYou"></div>
      <div class="avatar" id="celebrateThem"></div>
    </div>
    <h3>It's a match!</h3>
    <p id="celebrateText">You're both in the same league.</p>
    <button class="btn btn-primary" id="btnCelebrateClose" type="button">Keep swiping</button>
  </div>
</div>

<script>
(function(){
  "use strict";

  var BLOB_PATHS = [
    "M50 8C68 8 82 22 86 40C90 58 78 74 60 84C42 94 22 86 12 68C2 50 8 28 24 16C32 10 42 8 50 8Z",
    "M52 6C72 10 90 26 88 46C86 66 68 82 48 88C28 94 10 82 6 62C2 42 12 22 30 12C38 8 46 4 52 6Z",
    "M46 10C64 4 84 14 90 32C96 50 88 70 70 82C52 94 30 92 16 78C2 64 4 42 16 26C24 16 34 14 46 10Z",
    "M50 4C70 4 88 18 92 38C96 58 84 78 64 88C44 98 20 92 10 74C0 56 6 32 22 18C30 10 40 4 50 4Z",
    "M48 12C66 2 88 10 94 30C100 50 92 72 74 86C56 100 30 96 14 80C-2 64 2 40 18 22C26 14 38 16 48 12Z",
    "M54 8C74 12 88 30 86 50C84 70 66 86 46 86C26 86 10 70 10 50C10 30 26 12 46 8C48.7 7.4 51.3 7.4 54 8Z"
  ];
  function avatarSVG(variant, hexColor){
    var p1 = BLOB_PATHS[variant % BLOB_PATHS.length];
    var p2 = BLOB_PATHS[(variant + 3) % BLOB_PATHS.length];
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<rect width="100" height="100" fill="' + hexColor + '" opacity="0.16"/>' +
      '<path d="' + p1 + '" fill="' + hexColor + '" opacity="0.85" transform="translate(2,3) scale(0.94)"/>' +
      '<path d="' + p2 + '" fill="#f8efe8" opacity="0.14" transform="translate(-4,4) scale(0.62) translate(20,20)"/>' +
      '</svg>';
  }
  function crestSVG(hexColor){
    return '<svg class="crest" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M12 2L20 6V12C20 17 16.6 20.7 12 22C7.4 20.7 4 17 4 12V6L12 2Z" fill="' + hexColor + '" opacity="0.9"/>' +
      '<path d="M12 6.5L9 12L12 17.5L15 12L12 6.5Z" fill="#1a1120" opacity="0.55"/>' +
      '</svg>';
  }

  var LEAGUES = [
    { id:"1M",  label:"1M League",   min:1e6,   max:4.999e6, pool:214880, hex:"#d69a6e", pct:100 },
    { id:"5M",  label:"5M League",   min:5e6,   max:9.999e6, pool:42110,  hex:"#cfd8e6", pct:74  },
    { id:"10M", label:"10M League",  min:10e6,  max:99.9e6,  pool:9340,   hex:"#ffcf6b", pct:56  },
    { id:"100M",label:"100M League", min:100e6, max:999e6,   pool:612,    hex:"#f0839c", pct:32  },
    { id:"1B+", label:"1B+ League",  min:1e9,   max:Infinity,pool:7,      hex:"#cba8ff", pct:12  }
  ];
  function leagueById(id){ for (var i=0;i<LEAGUES.length;i++){ if (LEAGUES[i].id===id) return LEAGUES[i]; } return null; }
  function leagueColorHex(id){ var l = leagueById(id); return l ? l.hex : "#ffcf6b"; }
  function fmt(n){ return Math.round(n).toLocaleString("en-US"); }
  function variantFor(handle){ var h=0; for (var i=0;i<handle.length;i++){ h=(h*31+handle.charCodeAt(i))>>>0; } return h % BLOB_PATHS.length; }

  var state = { connected:false };
  var stackIndex = 0;
  var provider = "claude-code";
  function providerLabel(){ return provider === "codex" ? "Codex" : "Claude Code"; }

  var steps = {};
  document.querySelectorAll("[data-step]").forEach(function(el){ steps[el.getAttribute("data-step")] = el; });
  function showStep(name){
    Object.keys(steps).forEach(function(k){ steps[k].classList.toggle("is-active", k === name); });
  }

  document.getElementById("idleAvatar").innerHTML = avatarSVG(3, "#ffb15e");
  document.getElementById("consentAvatar").innerHTML = avatarSVG(3, "#ffb15e");

  document.querySelectorAll(".provider-picker button").forEach(function(btn){
    btn.addEventListener("click", function(){
      document.querySelectorAll(".provider-picker button").forEach(function(b){ b.classList.remove("is-active"); });
      btn.classList.add("is-active");
      provider = btn.getAttribute("data-harness") || "claude-code";
    });
  });

  document.getElementById("btnConnect").addEventListener("click", function(){
    document.getElementById("consentProviderLabel").textContent = "Connecting " + providerLabel() + "...";
    showStep("consent");
  });
  document.getElementById("btnCancel").addEventListener("click", function(){ showStep("idle"); });

  var VERIFY_STEPS = ["Contacting your {p} CLI...","Requesting read-only usage-history scope...","Counting tokens (not reading them)...","Computing your league..."];
  function runConnect(){
    showStep("verifying");
    var fillEl = document.getElementById("progressFill");
    var stepText = document.getElementById("verifyStepText");
    fillEl.style.width = "0%";
    void fillEl.offsetWidth;
    requestAnimationFrame(function(){ fillEl.style.width = "100%"; });
    var i = 0;
    var iv = setInterval(function(){
      stepText.textContent = VERIFY_STEPS[i % VERIFY_STEPS.length].split("{p}").join(providerLabel());
      i++;
    }, 430);

    fetch("/api/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: provider })
    }).then(function(r){
      if (!r.ok) throw new Error("connect failed");
      return r.json();
    }).then(function(s){
      clearInterval(iv);
      applyState(s);
    }).catch(function(){
      clearInterval(iv);
      showStep("error");
    });
  }
  document.getElementById("btnAuthorize").addEventListener("click", runConnect);
  document.getElementById("btnRetry").addEventListener("click", runConnect);

  function applyState(s){
    state = s || { connected:false };
    if (state.connected){
      renderReveal(state);
      renderYouMarker(state.league);
      stackIndex = 0;
      renderStack();
      showStep("reveal");
    } else {
      stackIndex = 0;
      renderStack();
      showStep("idle");
    }
  }

  function renderReveal(s){
    var lg = leagueById(s.league);
    var hex = lg ? lg.hex : "#ffcf6b";
    document.getElementById("revealAvatar").innerHTML = avatarSVG(3, hex);
    document.getElementById("revealHandle").textContent = (s.handle || "@you") + " - " + (s.harness || "Claude Code");

    var vline = document.getElementById("verifiedLine");
    vline.innerHTML = s.verified
      ? "<span>&#10003;</span> usage verified - read-only OAuth"
      : "<span>&#10003;</span> usage read locally - self-reported";

    document.getElementById("rawCounter").textContent = "usage aggregated locally";
    document.getElementById("rawReveal").textContent = fmt(s.totalTokens) + " tokens - never leaves this device.";

    var badge = document.getElementById("leagueBadge");
    badge.classList.remove("is-in");
    badge.style.background = "color-mix(in srgb, " + hex + " 16%, transparent)";
    badge.style.border = "1px solid color-mix(in srgb, " + hex + " 42%, transparent)";
    badge.style.color = hex;
    badge.innerHTML = crestSVG(hex) + "<span>" + (lg ? lg.label : (s.league + " League")) + "</span>";
    requestAnimationFrame(function(){ badge.classList.add("is-in"); });

    var traitsRow = document.getElementById("traitsRow");
    traitsRow.innerHTML = "";
    var TRAITS = ["night-shift committer","refactor-heavy","context-window hoarder","test-coverage maximalist"];
    TRAITS.forEach(function(t, idx){
      var chip = document.createElement("span");
      chip.className = "trait";
      chip.textContent = t;
      chip.style.animationDelay = (idx * 0.09 + 0.05) + "s";
      traitsRow.appendChild(chip);
      requestAnimationFrame(function(){ chip.classList.add("is-in"); });
    });
  }

  var rawToggle = document.getElementById("rawToggle");
  rawToggle.addEventListener("click", function(){
    var open = this.getAttribute("aria-expanded") === "true";
    this.setAttribute("aria-expanded", String(!open));
    document.getElementById("rawReveal").classList.toggle("is-open", !open);
    this.textContent = open ? "show raw usage (visible only to you)" : "hide raw usage";
  });

  document.getElementById("btnReset").addEventListener("click", function(){
    state = { connected:false };
    document.getElementById("rawReveal").classList.remove("is-open");
    rawToggle.setAttribute("aria-expanded","false");
    rawToggle.textContent = "show raw usage (visible only to you)";
    document.querySelectorAll(".you-marker").forEach(function(m){ m.remove(); });
    stackIndex = 0;
    renderStack();
    showStep("idle");
  });

  var ladderRowsEl = document.getElementById("ladderRows");
  LEAGUES.forEach(function(l){
    var row = document.createElement("div");
    row.className = "ladder-row";
    row.setAttribute("data-league", l.id);
    row.innerHTML =
      '<span class="ladder-label" style="color:' + l.hex + '">' + l.id + '</span>' +
      '<span class="ladder-bar-track"><span class="ladder-bar-fill" style="background:' + l.hex + '"></span></span>' +
      '<span class="ladder-pool mono">' + fmt(l.pool) + '</span>';
    ladderRowsEl.appendChild(row);
    requestAnimationFrame(function(){ row.querySelector(".ladder-bar-fill").style.width = l.pct + "%"; });
  });
  function renderYouMarker(leagueId){
    document.querySelectorAll(".you-marker").forEach(function(m){ m.remove(); });
    var row = ladderRowsEl.querySelector('[data-league="' + leagueId + '"]');
    if (!row) return;
    var marker = document.createElement("span");
    marker.className = "you-marker";
    marker.textContent = "YOU";
    row.querySelector(".ladder-label").appendChild(marker);
    requestAnimationFrame(function(){ marker.classList.add("is-in"); });
  }

  var explainerBtn = document.getElementById("explainerBtn");
  var explainerPanel = document.getElementById("explainerPanel");
  explainerBtn.addEventListener("click", function(){
    var open = explainerBtn.getAttribute("aria-expanded") === "true";
    explainerBtn.setAttribute("aria-expanded", String(!open));
    explainerPanel.classList.toggle("is-open", !open);
  });

  var cardStackEl = document.getElementById("cardStack");
  function renderStack(){
    cardStackEl.innerHTML = "";
    var pool = state.connected && state.candidates ? state.candidates : [];
    var visible = pool.slice(stackIndex, stackIndex + 3);
    if (visible.length === 0){
      var empty = document.createElement("div");
      empty.className = "empty-state";
      if (!state.connected){
        empty.innerHTML = "<strong>Connect to see matches.</strong><p>Read your usage to get sorted into a league and start matching.</p>";
      } else {
        empty.innerHTML = "<strong>That's everyone in range.</strong><p>You've matched through today's pool. It refreshes with the next billing cycle.</p>" +
          '<button class="btn btn-primary" id="btnRestart" type="button" style="width:auto;padding:11px 20px;">Start over</button>';
      }
      cardStackEl.appendChild(empty);
      var restart = empty.querySelector("#btnRestart");
      if (restart) restart.addEventListener("click", function(){ stackIndex = 0; renderStack(); });
      return;
    }
    visible.forEach(function(cand, depth){
      var el = document.createElement("article");
      el.className = "match-card";
      el.setAttribute("data-depth", depth);
      var lg = leagueById(cand.league);
      var hex = lg ? lg.hex : "#ffcf6b";
      var label = lg ? lg.label : (cand.league + " League");
      var bio = cand.bio || [];
      el.innerHTML =
        '<div class="mc-top">' +
          '<div class="mc-avatar">' + avatarSVG(variantFor(cand.handle), hex) + '</div>' +
          '<div>' +
            '<div class="mc-handle">' + cand.handle + '</div>' +
            '<span class="mc-league" style="background:color-mix(in srgb,' + hex + ' 16%, transparent);border:1px solid color-mix(in srgb,' + hex + ' 40%, transparent);color:' + hex + '">' + label + '</span>' +
            '<div class="mc-verified">&#10003; usage verified</div>' +
          '</div>' +
        '</div>' +
        '<div class="mc-bio"><p>' + (bio[0] || "") + '</p><p>' + (bio[1] || "") + '</p></div>' +
        (depth === 0 ?
          '<div class="mc-actions">' +
            '<button class="round-btn pass" type="button" title="Pass">&#10005;</button>' +
            '<button class="round-btn like" type="button" title="Like">&#9829;</button>' +
            '<span class="hint"></span>' +
          '</div>' : '');
      cardStackEl.appendChild(el);
      if (depth === 0){
        el.querySelector(".pass").addEventListener("click", function(){ swipe(el, cand, "pass"); });
        el.querySelector(".like").addEventListener("click", function(){ swipe(el, cand, "like"); });
      }
    });
  }

  function swipe(el, cand, dir){
    el.classList.add(dir === "like" ? "fly-like" : "fly-pass");
    var isMatch = dir === "like" && state.league && cand.league === state.league;
    setTimeout(function(){
      stackIndex++;
      renderStack();
      if (isMatch) openCelebrate(cand);
    }, 360);
  }

  var celebrateEl = document.getElementById("celebrate");
  function openCelebrate(cand){
    var lg = leagueById(cand.league);
    var hex = lg ? lg.hex : "#ffcf6b";
    var youHex = state.league ? leagueColorHex(state.league) : "#ffcf6b";
    document.getElementById("celebrateYou").innerHTML = avatarSVG(3, youHex);
    document.getElementById("celebrateThem").innerHTML = avatarSVG(variantFor(cand.handle), hex);
    document.getElementById("celebrateText").textContent = "You're both in the " + (lg ? lg.label : (cand.league + " League")) + ". " + cand.handle + " just entered the stack.";
    celebrateEl.classList.add("is-open");
  }
  document.getElementById("btnCelebrateClose").addEventListener("click", function(){ celebrateEl.classList.remove("is-open"); });
  celebrateEl.addEventListener("click", function(e){ if (e.target === celebrateEl) celebrateEl.classList.remove("is-open"); });

  renderStack();
  requestAnimationFrame(function(){ document.body.classList.add("loaded"); });

  fetch("/api/state").then(function(r){ return r.json(); }).then(function(s){ applyState(s); }).catch(function(){ showStep("idle"); });

})();
</script>
</body>
</html>`;
