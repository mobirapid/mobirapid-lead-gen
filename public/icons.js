// Shared SVG icon set (stroke = currentColor). Used by the landing page and admin.
(function () {
  const svg = (inner) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="26" height="26" aria-hidden="true">${inner}</svg>`;

  window.MOBI_ICONS = {
    invoice: svg('<path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>'),
    qc: svg('<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M9 12l2 2 4-4"/>'),
    warranty: svg('<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/><path d="M12 8v4l3 2"/>'),
    openbox: svg('<path d="M3 8l9-5 9 5-9 5-9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
    card: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>'),
    exchange: svg('<path d="M4 7h13l-3-3M20 17H7l3 3"/>'),
    truck: svg('<path d="M3 6h11v9H3z"/><path d="M14 9h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>'),
    shield: svg('<path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/>'),
    tag: svg('<path d="M3 12l9-9 9 9-9 9z"/><circle cx="9" cy="9" r="1.4"/>'),
    star: svg('<path d="M12 3l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8L6.6 19.6l1-6L3.3 9.4l6-.9z"/>'),
    lock: svg('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
    headset: svg('<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2" y="13" width="5" height="7" rx="1.5"/><rect x="17" y="13" width="5" height="7" rx="1.5"/><path d="M20 20a4 4 0 0 1-4 3h-2"/>'),
    rupee: svg('<path d="M7 4h10M7 8h10M16 4c0 5-4 5-9 5l8 7"/>'),
    instagram: svg('<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.6" fill="currentColor"/>'),
    facebook: svg('<path d="M15 3h-2.5A4.5 4.5 0 0 0 8 7.5V10H5v3h3v8h3v-8h2.5l.5-3H11V7.5A1.5 1.5 0 0 1 12.5 6H15z"/>'),
    email: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M3 6l9 7 9-7"/>'),
    phone: svg('<path d="M4 4h4l2 5-3 2a13 13 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 2 6a2 2 0 0 1 2-2z"/>'),
    whatsapp: svg('<path d="M3 21l1.6-5A8 8 0 1 1 8 19.4z"/><path d="M9 8.5c0 4 2.5 6.5 6.5 6.5 0 0 1.5 0 1.5-1.5 0-.5-2-1.2-2.3-1.1-.4.1-.8 1-.8 1-1.2-.4-2.3-1.5-2.7-2.7 0 0 .9-.4 1-.8.1-.3-.6-2.3-1.1-2.3C9.5 6.9 9 8 9 8.5z"/>'),
    linkedin: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 10v7"/><circle cx="7" cy="7" r="0.6" fill="currentColor"/><path d="M11 17v-4a2 2 0 0 1 4 0v4M11 10v7"/>'),
    mappin: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>'),
    videocall: svg('<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3z"/>'),
    battery: svg('<rect x="3" y="8" width="15" height="8" rx="2"/><path d="M21 11v2"/><path d="M6.5 11v2"/>'),
    display: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    keyboard: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>'),
    plug: svg('<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>'),
    camera: svg('<rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="12" cy="13" r="3"/><path d="M8.5 7l1.2-2h4.6l1.2 2"/>'),
    storage: svg('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
    cpu: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'),
    wifi: svg('<path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>'),
  };

  // List for admin dropdowns: [key, label]
  window.MOBI_ICON_LIST = [
    ['invoice', 'Invoice / document'],
    ['qc', 'QC / checkmark shield'],
    ['warranty', 'Warranty / shield'],
    ['openbox', 'Open box'],
    ['card', 'Credit card'],
    ['exchange', 'Buyback / exchange'],
    ['truck', 'Delivery / truck'],
    ['shield', 'Shield'],
    ['tag', 'Price tag'],
    ['star', 'Star'],
    ['lock', 'Secure / lock'],
    ['headset', 'Support'],
    ['rupee', 'Rupee'],
    ['videocall', 'Video call'],
    ['battery', 'Battery'],
    ['display', 'Display'],
    ['keyboard', 'Keyboard'],
    ['plug', 'Ports / plug'],
    ['camera', 'Camera'],
    ['storage', 'Storage'],
    ['cpu', 'Processor'],
    ['wifi', 'Wi-Fi'],
  ];
})();
