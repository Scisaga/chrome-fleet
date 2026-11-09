// Synthetic desktop contents for documentation screenshots, never a live VNC session.
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function documentationDesktopHtml(profile, locale) {
  const en = locale === 'en';
  const title = escape(profile.name);
  const email = escape(profile.googleBinding?.email || 'content@example.test');
  const labels = en ? {
    badge: 'DEMO WORKSPACE', description: 'Example content in a separate browser environment.', search: 'Search this workspace',
    overview: 'Overview', notes: 'Notes', history: 'Activity', count: "Today's notes", pending: 'To review', saved: 'Saved items',
    section: 'Workspace notes', updated: 'Updated today', name: 'Item', status: 'Status', time: 'Updated',
    rows: ['Product documentation', 'Research notes', 'Project references'], states: ['Organized', 'In progress', 'Organized'],
    note: 'Separate browser, familiar workspace', body: 'Keep research, project notes and reference materials together in this browser.', demo: 'Synthetic documentation example',
  } : {
    badge: '示例工作空间', description: '在独立浏览器中保留每一段工作内容。', search: '搜索当前工作空间',
    overview: '工作概览', notes: '资料笔记', history: '活动记录', count: '今日资料', pending: '待处理事项', saved: '已收藏内容',
    section: '工作资料', updated: '今日更新', name: '资料名称', status: '状态', time: '更新时间',
    rows: ['产品文档', '市场调研笔记', '项目参考资料'], states: ['已整理', '整理中', '已整理'],
    note: '独立的浏览器，熟悉的工作空间', body: '在这个浏览器中集中整理调研、项目笔记和参考资料。', demo: '仅用于文档截图的合成内容',
  };
  return `<!doctype html><html lang="${en ? 'en' : 'zh-CN'}"><meta charset="utf-8"><title>${title} · Example Workspace</title><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#161b27;font-family:Arial,'Noto Sans CJK SC',sans-serif;color:#30394d}
    .desktop-window{width:1440px;height:900px;transform:scale(var(--scale,1));transform-origin:top left;background:#f4f6fa}
    .tabs{height:44px;background:#e7eaf2;display:flex;align-items:end;gap:18px;padding:7px 16px 0;color:#727d91;font-size:14px}.tab{height:37px;width:270px;padding:10px 16px;background:white;border-radius:10px 10px 0 0;color:#3d4659}.dot{color:#7f70cc;margin-right:12px}.window-controls{margin-left:auto;align-self:center;letter-spacing:21px;font-size:18px;padding-bottom:7px}
    .address{height:48px;display:flex;align-items:center;gap:20px;background:white;padding:8px 22px;color:#8b94a6;border-bottom:1px solid #e5e9f1}.url{height:31px;line-height:31px;flex:1;background:#f2f4f8;border-radius:18px;padding:0 18px;font-size:13px;color:#717c91}.toolbar-dot{font-size:19px}
    main{padding:42px 66px}header{display:flex;align-items:center;justify-content:space-between}.eyebrow{font-size:12px;letter-spacing:2px;color:#8f82b9;font-weight:700}h1{font-size:34px;letter-spacing:-.7px;margin:10px 0}p{font-size:15px;line-height:1.8;color:#8992a4;margin:0}.search{border:1px solid #e0e5ee;background:white;border-radius:8px;padding:14px 22px;width:265px;font-size:14px;color:#a0a7b6}.navigation{display:flex;gap:34px;margin:31px 0 25px;border-bottom:1px solid #e2e6ef;font-size:14px;color:#939bae}.navigation span{padding:0 0 13px}.navigation span:first-child{color:#7564bf;border-bottom:3px solid #8a79cd}
    .metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.metric{background:white;border:1px solid #e2e6ef;padding:22px 25px;border-radius:10px}.metric label{font-size:13px;color:#9199a9}.metric strong{display:block;font-size:34px;font-weight:500;margin-top:9px;color:#48536a}.metric small{font-size:11px;color:#8daf9d;float:right;margin-top:-20px}
    .content{display:grid;grid-template-columns:1.65fr 1fr;gap:23px;margin-top:25px}.panel{background:white;border:1px solid #e2e6ef;border-radius:11px;padding:26px}.panel h2{font-size:18px;margin:0 0 25px;font-weight:600}.panel h2 small{float:right;font-size:11px;font-weight:400;color:#9aa3b3}.row{display:grid;grid-template-columns:1.7fr 1fr .7fr;align-items:center;gap:15px;font-size:14px;color:#687489;padding:20px 0;border-top:1px solid #edf0f5}.row.table-head{font-size:12px;color:#a1a9b7;border:0;padding:0 0 15px}.state{font-size:11px;color:#649981;background:#eff7f3;border-radius:5px;width:max-content;padding:5px 9px}.state.pending{background:#f4f0fb;color:#9482b8}.note{background:#f2effa;border:1px solid #e6dff6}.note h2{font-size:23px;line-height:1.6;color:#7b69b1;margin-top:35px;margin-bottom:16px}.note p{font-size:14px;line-height:2;color:#9a90ae}.note .mark{font-size:28px;color:#aa9bce}.footer{margin-top:32px;font-size:11px;color:#a4acba;letter-spacing:1px}
  </style><div class="desktop-window"><div class="tabs"><div class="tab"><span class="dot">●</span>${title}　 ×</div><span>+</span><span class="window-controls">− □ ×</span></div><div class="address"><span>←</span><span>→</span><span>↻</span><div class="url">⌕　workspace.example.test/${profile.id.slice(-1)}</div><span class="toolbar-dot">⋮</span></div><main><header><div><div class="eyebrow">${labels.badge}</div><h1>${title}</h1><p>${labels.description}</p></div><div class="search">⌕　${labels.search}</div></header><div class="navigation"><span>${labels.overview}</span><span>${labels.notes}</span><span>${labels.history}</span></div><div class="metrics">${[labels.count, labels.pending, labels.saved].map((label, index) => `<div class="metric"><label>${label}</label><strong>${['12', '04', '26'][index]}</strong><small>${['+3', '02 / 04', '+6'][index]}</small></div>`).join('')}</div><div class="content"><section class="panel"><h2>${labels.section}<small>${labels.updated}</small></h2><div class="row table-head"><span>${labels.name}</span><span>${labels.status}</span><span>${labels.time}</span></div>${labels.rows.map((name, index) => `<div class="row"><span>${name}</span><span class="state ${index === 1 ? 'pending' : ''}">${labels.states[index]}</span><span>${['09:08', '08:52', '08:30'][index]}</span></div>`).join('')}</section><section class="panel note"><div class="mark">▤</div><h2>${labels.note}</h2><p>${labels.body}</p><p style="margin-top:24px">${email}</p></section></div><div class="footer">EXAMPLE WORKSPACE · ${labels.demo}</div></main></div><script>function fit(){document.documentElement.style.setProperty('--scale',Math.min(innerWidth/1440,innerHeight/900))}addEventListener('resize',fit);fit();</script></html>`;
}

export function documentationVncHtml(profile, session, locale) {
  return `<!doctype html><html lang="${locale === 'en' ? 'en' : 'zh-CN'}"><meta charset="utf-8"><title>${escape(profile.name)}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#161b27}img{display:block;width:100%;height:100%;object-fit:contain}</style><img alt="${escape(profile.name)}" src="/_documentation/desktops/${locale}/${profile.id}.png"><script>
    const context={profileId:${JSON.stringify(profile.id)},sessionId:${JSON.stringify(session.id)}};
    window.inputEnabled=false;
    function state(){if(parent!==window)parent.postMessage({type:'fleet-desktop-state',...context,state:'connected'},location.origin)}
    addEventListener('message',event=>{const data=event.data;if(event.source!==parent||event.origin!==location.origin||data?.type!=='fleet-desktop-command'||data.profileId!==context.profileId||data.sessionId!==context.sessionId)return;if(data.action==='activate')window.inputEnabled=data.active===true;});
    document.querySelector('img').addEventListener('load',state);
  </script></html>`;
}
