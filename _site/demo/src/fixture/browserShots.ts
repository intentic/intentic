/* Browser evidence carried by the recorded persona conversation. SVG keeps the capture sharp inside a narrow
 * chat card and lets the demo serve it through the same /workspace/raw path as every real browser artifact. */

export const SUPPORT_SWEEP_PATH = `.intentic/records/artifacts/browser/maya-support-sweep.svg`;

export const SUPPORT_SWEEP_SHOT = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="520" viewBox="0 0 1280 520">
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7f8fc"/>
      <stop offset="1" stop-color="#eef1f7"/>
    </linearGradient>
    <linearGradient id="violet" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7157e8"/>
      <stop offset="1" stop-color="#9d6df2"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="13" flood-color="#27314d" flood-opacity=".14"/>
    </filter>
  </defs>

  <rect width="1280" height="520" rx="28" fill="url(#page)"/>
  <circle cx="1142" cy="-28" r="180" fill="#e7defd" opacity=".75"/>
  <circle cx="70" cy="520" r="180" fill="#dcecfb" opacity=".72"/>

  <g font-family="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">
    <text x="38" y="43" font-size="18" font-weight="700" fill="#20263a">Overnight support sweep</text>
    <circle cx="238" cy="37" r="5" fill="#27b07d"/>
    <text x="250" y="43" font-size="14" font-weight="600" fill="#40705f">completed by Maya</text>
    <rect x="1116" y="21" width="126" height="30" rx="15" fill="#e7f7f0"/>
    <path d="M1136 36l5 5 10-11" fill="none" stroke="#24966b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="1160" y="41" font-size="13" font-weight="700" fill="#28795d">Queue clear</text>

    <!-- Inbox capture -->
    <g filter="url(#shadow)">
      <rect x="36" y="72" width="770" height="414" rx="18" fill="#fff"/>
      <path d="M54 72h734a18 18 0 0 1 18 18v34H36V90a18 18 0 0 1 18-18z" fill="#f8f9fc"/>
    </g>
    <circle cx="60" cy="98" r="5" fill="#fd6a68"/>
    <circle cx="78" cy="98" r="5" fill="#f4bd4f"/>
    <circle cx="96" cy="98" r="5" fill="#4ac96e"/>
    <rect x="134" y="84" width="466" height="28" rx="9" fill="#eef0f5"/>
    <path d="M151 99a7 7 0 1 1 13 0 7 7 0 0 1-13 0m12 6 5 5" fill="none" stroke="#8a91a6" stroke-width="2" stroke-linecap="round"/>
    <text x="179" y="103" font-size="13" fill="#6c748a">app.intercom.com/inbox/atlas-goods</text>
    <circle cx="775" cy="98" r="12" fill="url(#violet)"/>
    <text x="775" y="103" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">M</text>

    <rect x="36" y="124" width="64" height="362" fill="#292b42"/>
    <rect x="49" y="142" width="38" height="38" rx="11" fill="url(#violet)"/>
    <text x="68" y="168" text-anchor="middle" font-size="18" font-weight="800" fill="#fff">A</text>
    <rect x="51" y="210" width="34" height="34" rx="10" fill="#41445e"/>
    <path d="M59 221h18v12H66l-5 4v-4h-2z" fill="none" stroke="#dfe1eb" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="84" cy="211" r="7" fill="#ff7a8b"/>
    <text x="84" y="215" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">3</text>
    <path d="M58 269h20M58 277h14" stroke="#8e93aa" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M58 318h20M68 308v20" stroke="#8e93aa" stroke-width="2.5" stroke-linecap="round"/>

    <rect x="100" y="124" width="226" height="362" fill="#fafbfe"/>
    <line x1="326" y1="124" x2="326" y2="486" stroke="#e5e7ee"/>
    <text x="122" y="157" font-size="18" font-weight="750" fill="#252a3d">Inbox</text>
    <rect x="242" y="139" width="63" height="26" rx="13" fill="#eaf7f1"/>
    <text x="273" y="156" text-anchor="middle" font-size="12" font-weight="700" fill="#28795d">3 open</text>
    <rect x="117" y="177" width="192" height="32" rx="10" fill="#f0f2f7"/>
    <text x="135" y="198" font-size="12" fill="#8b91a3">Search conversations</text>

    <rect x="111" y="222" width="204" height="78" rx="12" fill="#eeeafb"/>
    <circle cx="137" cy="247" r="16" fill="#d8e9fc"/>
    <text x="137" y="253" text-anchor="middle" font-size="14" font-weight="700" fill="#416b94">J</text>
    <text x="163" y="243" font-size="13" font-weight="750" fill="#252a3d">Jordan Lee</text>
    <text x="288" y="243" text-anchor="end" font-size="10" fill="#8b91a3">4m</text>
    <text x="163" y="263" font-size="11" fill="#646c81">SSO rollout is blocked…</text>
    <rect x="163" y="273" width="72" height="18" rx="9" fill="#fff"/>
    <text x="199" y="286" text-anchor="middle" font-size="9" font-weight="700" fill="#7554d8">VIP · renewal</text>

    <circle cx="137" cy="331" r="16" fill="#fbe2d7"/>
    <text x="137" y="337" text-anchor="middle" font-size="14" font-weight="700" fill="#9a5b42">S</text>
    <text x="163" y="327" font-size="13" font-weight="700" fill="#30364a">Sam Rivera</text>
    <text x="163" y="347" font-size="11" fill="#777e91">Refund confirmed · $42</text>
    <path d="M122 370h183" stroke="#eaebf1"/>
    <circle cx="137" cy="397" r="16" fill="#def1e7"/>
    <text x="137" y="403" text-anchor="middle" font-size="14" font-weight="700" fill="#3b8060">A</text>
    <text x="163" y="393" font-size="13" font-weight="700" fill="#30364a">Ana Morris</text>
    <text x="163" y="413" font-size="11" fill="#777e91">Shipping address updated</text>
    <path d="M122 436h183" stroke="#eaebf1"/>
    <circle cx="137" cy="458" r="5" fill="#27b07d"/>
    <text x="151" y="463" font-size="11" font-weight="650" fill="#4b7565">14 routine items resolved</text>

    <rect x="327" y="124" width="479" height="362" fill="#fff"/>
    <text x="350" y="157" font-size="16" font-weight="750" fill="#252a3d">Jordan Lee · Northwind Labs</text>
    <rect x="678" y="139" width="104" height="26" rx="13" fill="#f7ecff"/>
    <text x="730" y="156" text-anchor="middle" font-size="11" font-weight="700" fill="#7951c6">$18k renewal</text>
    <line x1="327" y1="174" x2="806" y2="174" stroke="#eceef3"/>

    <circle cx="372" cy="215" r="17" fill="#d8e9fc"/>
    <rect x="401" y="191" width="335" height="69" rx="13" fill="#f4f5f8"/>
    <text x="419" y="215" font-size="12" fill="#343a4e">We’re stuck mapping our SCIM groups.</text>
    <text x="419" y="235" font-size="12" fill="#343a4e">Could someone help before the rollout?</text>
    <text x="704" y="250" font-size="9" fill="#969bad">08:17</text>

    <circle cx="762" cy="307" r="17" fill="url(#violet)"/>
    <text x="762" y="313" text-anchor="middle" font-size="13" font-weight="800" fill="#fff">M</text>
    <rect x="390" y="278" width="342" height="94" rx="13" fill="#eeeafb"/>
    <text x="410" y="303" font-size="12" fill="#30364a">I can get you unstuck. I’ve reviewed the logs</text>
    <text x="410" y="324" font-size="12" fill="#30364a">and reserved 20 minutes with our setup specialist</text>
    <text x="410" y="345" font-size="12" fill="#30364a">tomorrow at 10:30. Here’s the invite.</text>
    <text x="410" y="361" font-size="9" font-weight="650" fill="#7655d7">Draft ready · approved by Ada</text>

    <rect x="350" y="401" width="432" height="58" rx="13" fill="#fafbfe" stroke="#e6e8ef"/>
    <text x="369" y="425" font-size="12" fill="#a0a5b4">Reply to Jordan…</text>
    <rect x="695" y="414" width="69" height="32" rx="10" fill="url(#violet)"/>
    <text x="730" y="435" text-anchor="middle" font-size="12" font-weight="750" fill="#fff">Send</text>

    <!-- Calendar capture -->
    <g filter="url(#shadow)">
      <rect x="832" y="72" width="412" height="414" rx="18" fill="#fff"/>
      <path d="M850 72h376a18 18 0 0 1 18 18v34H832V90a18 18 0 0 1 18-18z" fill="#f8f9fc"/>
    </g>
    <circle cx="856" cy="98" r="5" fill="#fd6a68"/>
    <circle cx="874" cy="98" r="5" fill="#f4bd4f"/>
    <circle cx="892" cy="98" r="5" fill="#4ac96e"/>
    <rect x="928" y="84" width="276" height="28" rx="9" fill="#eef0f5"/>
    <text x="951" y="103" font-size="13" fill="#6c748a">calendar.google.com</text>

    <text x="856" y="157" font-size="17" font-weight="750" fill="#252a3d">Tomorrow</text>
    <text x="856" y="179" font-size="12" fill="#878da0">Tuesday, August 18</text>
    <line x1="856" y1="198" x2="1220" y2="198" stroke="#eceef3"/>
    <text x="856" y="226" font-size="11" fill="#9ba0af">10 AM</text>
    <line x1="900" y1="222" x2="1220" y2="222" stroke="#f0f1f5"/>
    <rect x="900" y="237" width="320" height="116" rx="14" fill="#eeeafb"/>
    <rect x="900" y="237" width="6" height="116" rx="3" fill="#8060df"/>
    <text x="923" y="267" font-size="14" font-weight="750" fill="#30284a">Northwind SSO setup</text>
    <text x="923" y="291" font-size="12" fill="#5d5570">10:30–10:50 · Google Meet</text>
    <circle cx="937" cy="324" r="15" fill="#d8e9fc"/>
    <text x="937" y="330" text-anchor="middle" font-size="12" font-weight="700" fill="#416b94">J</text>
    <circle cx="963" cy="324" r="15" fill="url(#violet)"/>
    <text x="963" y="330" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">M</text>
    <text x="991" y="329" font-size="11" font-weight="650" fill="#665d78">Jordan + Maya</text>

    <rect x="856" y="380" width="364" height="76" rx="14" fill="#f5fbf8" stroke="#dcefe6"/>
    <circle cx="883" cy="406" r="13" fill="#d9f1e6"/>
    <path d="M877 406l4 4 8-9" fill="none" stroke="#24966b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="906" y="407" font-size="12" font-weight="750" fill="#2d6952">Follow-up created</text>
    <text x="883" y="433" font-size="11" fill="#658174">Friday · confirm SCIM sync is healthy</text>
  </g>
</svg>`;
