/* THE LEGAL DOCUMENTS rendered at /privacy, /terms, /acceptable-use, /dpa and /subprocessors, and linked from
 * the platform's sign-in page. LEGAL_VERSION is the clickwrap version users accept at sign-in; bump it on any
 * material change (intentic-app stamps the accepted version on the user record).
 *
 * THESE ARE WRITTEN AGAINST THE CODE, and that is the only reason they can be this specific. Every window,
 * region, size and data category below was read out of the implementation, the retention sweep, the hosted
 * provisioner's region pick, the trial's per-account meter, the pool's Stripe wiring, rather than guessed at
 * from what a service like this usually does. The corollary is a maintenance duty: a change to any of those
 * makes a sentence here false, and a false privacy statement is a regulatory problem rather than stale copy.
 *
 * NOTE: drafted from the code-verified data flows. A Polish lawyer must review these before the hosted lane
 * opens to the public, in particular the liability caps (the operator is a sole trader with unlimited
 * personal liability) and the DPA, which is a contract the operator offers rather than merely a disclosure. */

import {
    LEGAL_CONTACT_EMAIL,
    LEGAL_ENTITY_ADDRESS,
    LEGAL_ENTITY_COUNTRY,
    LEGAL_ENTITY_NAME,
    LEGAL_ENTITY_TAX_ID,
    LEGAL_VERSION,
    PLATFORM_HOSTING_LOCATION,
} from "@intentic/constants";
// Re-exported so this package's existing consumers keep importing them from @intentic-dev/site-content.
export { LEGAL_CONTACT_EMAIL, LEGAL_VERSION };

export interface LegalTable {
    columns: string[];
    rows: string[][];
}

export interface LegalSection {
    heading: string;
    paragraphs: string[];
    list?: string[];
    table?: LegalTable;
}

export interface LegalDoc {
    title: string;
    intro: string;
    sections: LegalSection[];
}

/* The operator's identification, assembled from whatever is actually filled in. EU e-commerce law wants the
 * name, the address and the registration number published; the constants ship with the last two blank, and a
 * missing clause is dropped rather than rendered as an empty promise, see the note on those constants. */
const operatorIdentity = (): string => {
    const parts = [`${LEGAL_ENTITY_NAME}, a sole trader established in ${LEGAL_ENTITY_COUNTRY}`];
    if (LEGAL_ENTITY_ADDRESS !== ``) {
        parts.push(`registered at ${LEGAL_ENTITY_ADDRESS}`);
    }
    if (LEGAL_ENTITY_TAX_ID !== ``) {
        parts.push(`tax identification number ${LEGAL_ENTITY_TAX_ID}`);
    }
    return `${parts.join(`, `)} ("we", "us"). Contact: ${LEGAL_CONTACT_EMAIL}.`;
};

export const privacyDoc: LegalDoc = {
    title: "Privacy Policy",
    intro: `Effective ${LEGAL_VERSION}. This policy explains what personal data the intentic platform processes, why, where it goes, and what rights you have.`,
    sections: [
        {
            heading: "Who we are",
            paragraphs: [
                `The intentic platform (intentic.dev and the workspace app at app.intentic.dev) is operated by ${operatorIdentity()}`,
                "We act in two different roles, and the difference matters. For your account, your billing and the records of which sandboxes exist, we are the data controller and this policy governs. For the contents of a sandbox we host for you, we are a processor acting on your instructions: that relationship is governed by our Data Processing Agreement, which forms part of these documents.",
            ],
        },
        {
            heading: "What we collect about you",
            paragraphs: ["The platform itself stores your identity, where your sandboxes are, and what you have paid for:"],
            list: [
                "Account data: your name, email address and avatar, received from Google when you sign in, plus the version of these documents you accepted and when.",
                "Session data: a session token, and the IP address and browser user agent of each sign-in, kept to keep accounts secure. Expired sessions are deleted automatically.",
                "Sandbox records: sandbox names, their public addresses, and the connection tokens used to reach them. Tokens are stored encrypted.",
                "Hosted machine records: for a sandbox we host, the machine and volume identifiers at our infrastructure provider and the region it runs in.",
                "Teammate emails: addresses you enter when sharing a sandbox, stored so the invitee's account can find it. Invitations never accepted are deleted after 90 days.",
                "Membership and credit records: your subscription status and billing period from Stripe, and the ledger of credits you spent, which extension installs you donated to and which service runs you paid for. Kept 13 months so a full year of the public payout ledger stays auditable and you can query a charge.",
                "Trial usage: a per-day count of model messages you used on the free trial, so the daily allowance can be enforced.",
            ],
        },
        {
            heading: "What we do not collect",
            paragraphs: [
                "We run no analytics, no advertising and no tracking, on the website or in the app. The only cookie is the strictly necessary session cookie that keeps you signed in.",
                "Sandboxes you run yourself report nothing to us. There are no usage pings, no active-day signals and no counts: the creator payout pool is deliberately built so that nothing a sandbox could report is worth money, which is why it can ask for nothing.",
                "We never receive your payment card details. Stripe collects them directly and we see only a customer reference, the subscription status and the billing period.",
            ],
        },
        {
            heading: "Sandboxes you run yourself",
            paragraphs: [
                "When your sandbox runs on your own machine, your own server or your own cloud account, your code, files, credentials and everything your agent produces stay there. The platform stores the address and the token needed to reach it, and nothing of what is inside. Traffic between your browser and your sandbox passes through our tunnel provider to reach you, encrypted end to end.",
            ],
        },
        {
            heading: "Sandboxes we host for you",
            paragraphs: [
                "If you take the free hosted sandbox, we create a virtual machine and a disk for it at Fly.io and we pay for them. Everything you then put in that workspace: repositories, files, environment variables, credentials you choose to store there, and everything the agent writes, sits on that disk, which is infrastructure we arranged rather than infrastructure you own. This is the one part of the service where your working content is in our sphere, and it is why the Data Processing Agreement exists.",
                "We do not read it, and the product gives us no way to: the command path runs from your browser to the sandbox's own daemon, and the platform holds power over the machine (create it, stop it, start it, destroy it) rather than a path into it. We will not build ourselves such a path to satisfy an abuse complaint, a complaint is answered by stopping or destroying the machine.",
                "Two honest limits on that. Fly.io, as the operator of the physical infrastructure, necessarily has the access any infrastructure provider has to the memory and disks of the machines it runs; our agreement with them restricts what they may do with it. And a sandbox reachable from the internet is reachable by whatever you expose from it: what you publish from your workspace is published by you.",
            ],
        },
        {
            heading: "Where a hosted sandbox lives",
            paragraphs: [
                "If you provision a hosted sandbox from the European Economic Area, the United Kingdom or Switzerland, the machine and its disk are created in the European Union (Stockholm) and your workspace content stays there. Everyone else's is created in the United States (Ashburn, Virginia). The region is decided when the machine is created, from the country of that request, and it is recorded on the machine; the country itself is not stored.",
                ...(PLATFORM_HOSTING_LOCATION === ``
                    ? []
                    : [`The rest of the platform, the account database and the API, runs on servers in ${PLATFORM_HOSTING_LOCATION}.`]),
            ],
        },
        {
            heading: "AI models and your prompts",
            paragraphs: [
                "With your own subscription or API key, your prompts, workspace files and command output go from your sandbox directly to your model provider (Anthropic, or whichever you configure) under your agreement with them. That traffic does not pass through the platform, and we neither see nor store it.",
                "The free model trial is the exception, and it is worth understanding before you use it. It exists so you can chat before you own any AI subscription, and it works by serving your messages with our own Google Gemini keys, so for as long as you are on the trial, your prompts and the context sent with them pass through the platform on their way to Google. We do not store their content; we store only the daily count. Once you configure your own key, that stops. Do not put anything in a trial conversation that you would not want processed this way.",
            ],
        },
        {
            heading: "Who else processes your data",
            paragraphs: [
                "We use a small number of providers to run the service, listed with what each one does, where it processes data and under what safeguard, on our sub-processors page. We keep that page current and announce changes there before they take effect.",
                "Your own model provider is not among them: you contract with them directly, and they process your data under your agreement, not ours.",
            ],
        },
        {
            heading: "Legal bases",
            paragraphs: ["Under the GDPR we rely on:"],
            list: [
                "Performance of our contract with you (Art. 6(1)(b)) for account data, sandbox records, hosted machines, membership and credits.",
                "Our legitimate interest (Art. 6(1)(f)) in keeping accounts and infrastructure secure, for session and sign-in security data and for acting on abuse reports.",
                "Compliance with a legal obligation (Art. 6(1)(c)) for tax and accounting records of payments.",
            ],
        },
        {
            heading: "International transfers",
            paragraphs: [
                "Some of our providers are established in the United States. Where personal data reaches them, transfers are covered by the EU–US Data Privacy Framework where the provider is certified, and otherwise by the European Commission's Standard Contractual Clauses under that provider's data processing agreement. The sub-processors page states which applies to each.",
                "For hosted sandbox content specifically, the region rule above is what limits the transfer: European users' workspace content is not transferred out of the EU by us at all.",
            ],
        },
        {
            heading: "How long we keep things",
            paragraphs: ["A daily sweep enforces these windows automatically:"],
            list: [
                "Sessions and sign-in verifications: deleted when they expire.",
                "Unaccepted sandbox invitations: deleted after 90 days.",
                "Credit ledger, donations and service-run records: 13 months.",
                "Account, sandbox and membership records: until you delete your account.",
                "Payment records: as long as tax law requires us to keep them, currently five years from the end of the accounting year in Poland.",
                "A hosted sandbox's disk: destroyed with the machine, immediately, when you delete the sandbox or your account, and, for a machine without a membership, when it has gone unopened for the period published in the app, which we warn you about by email first. Our infrastructure provider's automatic daily snapshots of that disk are not destroyed with it, they expire on their own retention schedule, currently five days, so erasure completes within that window rather than instantly. We hold no other copy.",
            ],
        },
        {
            heading: "Your rights",
            paragraphs: [
                "You can access, correct, export and erase your data at any time: Settings offers self-service export and account deletion, and deletion takes effect immediately. You also have the rights to restriction, objection and portability under the GDPR.",
                `You can complain to the Polish supervisory authority (UODO, uodo.gov.pl) or to the authority where you live. For anything else, write to ${LEGAL_CONTACT_EMAIL} and we will answer within 30 days.`,
            ],
        },
        {
            heading: "Security incidents",
            paragraphs: [
                "If a breach affects your personal data, we will notify the supervisory authority within 72 hours where the GDPR requires it, and tell you directly and without undue delay where the breach is likely to result in a high risk to you.",
            ],
        },
        {
            heading: "Changes",
            paragraphs: [
                "We will update this policy as the service changes and move the effective date above. Material changes are announced in the app before they take effect, and re-accepted at sign-in.",
            ],
        },
    ],
};

export const termsDoc: LegalDoc = {
    title: "Terms of Service",
    intro: `Effective ${LEGAL_VERSION}. These terms govern your use of the intentic platform. By signing in you agree to them.`,
    sections: [
        {
            heading: "Who you are contracting with",
            paragraphs: [
                `The intentic platform is operated by ${operatorIdentity()}`,
                "The intentic software is open source under the MIT license in its entirety, the platform included. These terms cover the hosted service we operate. What you run yourself is yours, under that license, and nothing here restricts it.",
            ],
        },
        {
            heading: "What the service is",
            paragraphs: ["Four things, with different rules attached to each:"],
            list: [
                "The connection layer: accounts, and the link between your browser and sandboxes you run on your own infrastructure. Free.",
                "Hosted sandboxes: one virtual machine per account that we create and pay for at our infrastructure provider. Free, and subject to the section below.",
                "The membership: a paid monthly subscription that includes premium extensions and a daily allowance of credits.",
                "The model trial: a small daily allowance of AI messages served with our own model keys, so you can try the product before you own a subscription.",
            ],
        },
        {
            heading: "Your account",
            paragraphs: [
                "You sign in with Google and must be legally able to enter this agreement. If you are using the service for an organisation, you confirm you are authorised to bind it. You are responsible for everything done under your account and for keeping access to it secure. One person per account.",
            ],
        },
        {
            heading: "Sandboxes we host",
            paragraphs: [
                "You may have one hosted sandbox per account. We create it at Fly.io on a machine of the size published in the app, with a disk of the published size, and we pay the bill. It stops on its own after a period of inactivity and starts again when you return.",
                "Without a membership it also has an allowance of running time each calendar month, of the number of hours published in the app. Only time the machine is actually running counts against it; while it is asleep, nothing does. When the allowance is used up we will not start the machine again until the next month begins, and we will say so rather than failing quietly. We never stop a machine that is already running to enforce this. A membership removes the allowance entirely.",
                "Four things about it you should plan around, because they are not incidental limitations but the terms on which it is free:",
            ],
            list: [
                "There is no availability commitment. It is provided on a best-effort basis, it will sometimes be unavailable, and we owe you no service level, credit or refund for that.",
                "We run no backup service. Our infrastructure provider takes automatic daily snapshots of the disk and keeps them for a few days, but that is their disaster-recovery mechanism rather than a feature of ours: we offer no way to browse or restore one, and we will not restore one on request. Do not plan around it.",
                "Your own copy is the one that counts. Turn on desktop sync and the workspace mirrors continuously to a folder on your own computer, or keep your work in a git remote: the workspace is where work happens, not where it is kept.",
                "It does not wait for you indefinitely. Without a membership, a machine you have not opened for the period published in the app is destroyed along with its disk, after we email you a warning first. Opening it stops that. A member's machine is not destroyed for going unused.",
                "It is not for production. Do not run anything on it that other people depend on, and do not store the only copy of anything on it.",
            ],
        },
        {
            heading: "What we may do to a hosted sandbox",
            paragraphs: [
                "We can create, stop, start and destroy the machine. We cannot read what is on it, and we will not build ourselves a way to.",
                "We may stop or destroy a hosted machine: at your request; when you delete the sandbox or your account; immediately and without notice if it breaches our Acceptable Use Policy or if leaving it running would expose us or others to harm or legal liability; after telling you first, if we discontinue the hosted offering or if a machine without a membership has gone unopened for the period published in the app. We may also decline to start a machine whose free monthly running-time allowance is used up, until that allowance resets.",
                "Because we cannot inspect the machine, stopping or destroying it is the whole of our response to an abuse report: we cannot investigate what is inside, and we will not pretend to. Where we destroy a machine and the circumstances allow it, we will give you a chance to retrieve your data first; where they do not, we will not.",
            ],
        },
        {
            heading: "Your content and your responsibility",
            paragraphs: [
                "Everything you build stays yours. We claim no rights over your code, your data or what your agent produces, beyond the permission we need to operate the machine that holds it: storing it, moving it between our provider's systems, and restoring it after a restart.",
                "You are responsible for what is in your workspace and what leaves it: that you have the right to it, that it is lawful, and that publishing it or connecting it to third-party services complies with those services' terms. You are equally responsible for costs your work incurs in your own accounts, which we neither control nor cover.",
            ],
        },
        {
            heading: "Agents act with your authority",
            paragraphs: [
                "The product runs an autonomous AI agent that writes files, executes commands and reaches the network on your instruction. Treat everything it does as done by you, because as between us that is exactly what it is.",
                "AI output can be wrong, insecure or destructive, and an agent given credentials can act on real systems and spend real money. Review what it does before letting it touch anything you care about. We are not responsible for its output, for the actions you allow it to take, for what it deletes, or for what it costs you at your own providers.",
                "If your agent causes harm to someone else: traffic from a machine we host, a service it disrupts, data it exposes, that is your responsibility, and the indemnity below applies to it.",
            ],
        },
        {
            heading: "Acceptable use",
            paragraphs: [
                "Our Acceptable Use Policy forms part of these terms, and it is the document that matters most for hosted sandboxes: a machine we pay for, reachable from the internet, running code we cannot see. Breaching it is grounds for immediate suspension or destruction of the machine and termination of your account.",
            ],
        },
        {
            heading: "Membership, credits and payment",
            paragraphs: [
                "The membership is billed monthly in advance through Stripe, renews automatically until cancelled, and is stated exclusive of any VAT that applies to you. You can cancel at any time in Settings; cancellation takes effect at the end of the period you have paid for, and access continues until then. If a payment fails, membership benefits pause while Stripe retries.",
                "Credits are a daily allowance, reset at UTC midnight. They do not roll over, have no cash value, cannot be exchanged for money, and are not refundable once spent. A service run that never produces an answer is not charged; one that produces an answer you did not like is. What a run costs is shown before it runs.",
                "If you are a consumer in the EU, you have 14 days to withdraw from the subscription. By starting to use the membership within that period you ask us to begin immediately and accept that you will owe a proportionate amount for what you used before withdrawing. Creator earnings and payouts are governed by the terms published on the Earn pages.",
            ],
        },
        {
            heading: "The model trial",
            paragraphs: [
                "The trial serves a small daily allowance of messages with our own model keys, so your prompts pass through us on their way to the model provider while you use it: the Privacy Policy sets out what that means. It is a courtesy with no guarantee of availability, quality or continuity, we may change or end it at any time, and it is metered per account. Circumventing the meter, extra accounts, automation against it, resale of its output, ends it for you.",
            ],
        },
        {
            heading: "Extensions and the registry",
            paragraphs: [
                "The registry lists extensions published by third parties. We curate what is admitted and delist what does not belong, but we do not write, audit or warrant other people's code, and installing it runs it with your agent's authority. Judge it as you would any dependency. Extensions are licensed by their publishers, not by us.",
                `If something on the platform is unlawful, tell us at ${LEGAL_CONTACT_EMAIL} with enough detail to find it and to understand why. We will act on it, tell you what we did, and tell the affected user unless the law forbids it.`,
            ],
        },
        {
            heading: "Suspension and termination",
            paragraphs: [
                "You can stop using the service and delete your account at any time in Settings, which deletes your data immediately and destroys any hosted machine with it.",
                "We may suspend or terminate an account that breaches these terms or the Acceptable Use Policy: with notice where it is reasonable to give it, and without where the breach is serious or ongoing. We may also discontinue the free parts of the service, giving reasonable notice first. If we terminate for reasons other than your breach and you had paid for a membership, we refund the unused portion.",
            ],
        },
        {
            heading: "No warranties",
            paragraphs: [
                'The service is provided "as is" and "as available", without warranties of any kind, express or implied, including fitness for a particular purpose and non-infringement. It is under active development: features change and break. We do not warrant that it will be uninterrupted, secure or error-free, nor that the agent will produce correct or safe results.',
            ],
        },
        {
            heading: "Liability",
            paragraphs: [
                "For the parts of the service provided free of charge: the connection layer, hosted sandboxes and the trial, our liability is excluded to the maximum extent the law permits.",
                "For the paid membership, our total liability for all claims in any 12-month period is limited to what you paid us in that period. We are not liable in any case for indirect or consequential loss, lost profits, lost or corrupted data on infrastructure we do not control, or costs you incur at your own providers.",
                "Nothing here excludes liability that cannot be excluded by law: intentional harm, personal injury, and, if you are a consumer, your statutory rights.",
            ],
        },
        {
            heading: "Indemnity",
            paragraphs: [
                "If someone brings a claim against us because of what you did with the service: your content, your agent's actions, traffic from a machine we host for you, or your breach of these terms or the Acceptable Use Policy, you will defend us against it and cover the resulting costs, damages and legal fees. We will tell you promptly about any such claim and let you control the defence of it.",
                "This clause does not apply to consumers to the extent Polish law does not permit it.",
            ],
        },
        {
            heading: "Changes, law and disputes",
            paragraphs: [
                "We may update these terms. Material changes are announced in the app, take effect from the stated effective date, and are re-accepted at sign-in; continued use after that date means acceptance. If you do not accept a change, stop using the service and delete your account.",
                "These terms are governed by Polish law, and the courts of Poland have jurisdiction: except that if you are a consumer, you keep the protection of the mandatory law of your country of residence and may bring proceedings where you live. EU consumers may also use the European Commission's online dispute resolution platform (ec.europa.eu/consumers/odr).",
                `Contact: ${LEGAL_CONTACT_EMAIL}.`,
            ],
        },
    ],
};

export const acceptableUseDoc: LegalDoc = {
    title: "Acceptable Use Policy",
    intro: `Effective ${LEGAL_VERSION}. This policy applies to everything you do with the intentic platform, and above all to a sandbox we host for you. It forms part of the Terms of Service.`,
    sections: [
        {
            heading: "Why this exists",
            paragraphs: [
                "A hosted sandbox is a machine we pay for, reachable from the internet, running code we deliberately cannot see, driven by an agent that acts on its own. That arrangement only survives if the rules for using it are clear and the consequences are quick. This document is both.",
                "It applies to you, to anyone you share a sandbox with, and to your agent. An agent acting outside these rules is you acting outside them.",
            ],
        },
        {
            heading: "Do not use the platform to",
            paragraphs: ["The prohibitions, in the order they are most likely to come up:"],
            list: [
                "Mine cryptocurrency, farm tokens or run any workload whose purpose is to convert our compute into value. This is the abuse a free machine attracts most, and it is grounds for immediate destruction with no warning.",
                "Attack, scan, probe, flood or otherwise interfere with any system: ours, another user's, or anyone else's on the internet.",
                "Send spam or bulk unsolicited messages, or run automation that violates another service's terms of use.",
                "Host or distribute malware, ransomware, exploit kits, phishing pages, or infrastructure for fraud.",
                "Store or transmit material that is unlawful where you are or where the machine runs, and in particular child sexual abuse material, which we report to the authorities.",
                "Infringe intellectual property or misappropriate someone else's confidential information.",
                "Circumvent limits: the per-account hosted machine allowance, the trial meter, the credit allowance, or any other quota, whether by extra accounts, automation or otherwise.",
                "Resell the hosted sandbox, or provide it to third parties as your own service.",
                "Deploy production services or anything other people depend on. The hosted box is a workspace, not a hosting product, and it is sized and operated accordingly.",
            ],
        },
        {
            heading: "Fair use of a machine we pay for",
            paragraphs: [
                "The hosted sandbox is sized for one person's development work and priced at nothing. Use it that way: interactive work, builds, tests, agents doing your work. Sustained saturation of CPU, disk or network that is not doing your work is not fair use, whether it is deliberate or a runaway process you have not noticed.",
                "If usage patterns make the free offer unsustainable, we will change the offer publicly rather than quietly throttle individuals.",
            ],
        },
        {
            heading: "Credentials in a hosted workspace",
            paragraphs: [
                "You may put credentials in your workspace, most real work needs them. Understand the trade: they sit on a disk at our infrastructure provider, that provider snapshots the disk daily and keeps those snapshots for a few days, and an agent with access to a credential can use it. So a secret you delete from the workspace today still exists in a snapshot for a short while afterwards. Prefer scoped, short-lived credentials, rotate rather than delete when one leaks, and never put in a hosted workspace a credential whose compromise you could not survive.",
            ],
        },
        {
            heading: "How we enforce this",
            paragraphs: [
                "We cannot look inside your machine, so our response to a credible report or a clear signal from our infrastructure provider is to act on the machine itself: stop it, or destroy it.",
                "For anything that is causing active harm: an attack in progress, mining, illegal content reported to us with evidence, we act immediately and tell you afterwards. For anything else, we tell you first and give you a reasonable chance to fix it. Repeated or deliberate breaches end the account.",
                "We do not consider a stopped or destroyed machine a punishment to be appealed at length, but if we got it wrong, say so and we will look again.",
            ],
        },
        {
            heading: "Reporting abuse",
            paragraphs: [
                `Report anything on the platform that breaks these rules to ${LEGAL_CONTACT_EMAIL}. Include what you saw, where, and why it is a problem, and if you are reporting unlawful content, enough for us to find it and to satisfy ourselves that it is what you say it is.`,
                "We acknowledge reports, act on them, and tell the reporter what we did. Where we act against a user's content or machine, we tell that user what happened and why, unless the law forbids it.",
            ],
        },
    ],
};

export const dpaDoc: LegalDoc = {
    title: "Data Processing Agreement",
    intro: `Effective ${LEGAL_VERSION}. This agreement applies when we process personal data on your behalf, in practice, when you use a sandbox we host. It is concluded between you (the controller) and us (the processor) as part of the Terms of Service, and satisfies Article 28 of the GDPR. No signature is needed; accepting the Terms concludes it.`,
    sections: [
        {
            heading: "When this applies",
            paragraphs: [
                "It applies to personal data that ends up inside a sandbox we host for you: in repositories, files, databases or logs in that workspace, where you decide what is there and why.",
                "It does not apply to your account, membership or sandbox records: for those we decide the purposes ourselves and act as controller, governed by the Privacy Policy. It also does not apply to a sandbox you run on your own infrastructure, because nothing of its contents reaches us.",
            ],
        },
        {
            heading: "The processing, in the terms Article 28 asks for",
            paragraphs: [],
            table: {
                columns: ["Item", "What it is here"],
                rows: [
                    ["Subject matter", "Hosting a development workspace on a virtual machine and disk we provide"],
                    ["Duration", "For as long as the hosted sandbox exists; it ends when you delete the sandbox or your account"],
                    [
                        "Nature and purpose",
                        "Storage, and the operations needed to run a machine: creating, stopping, starting, restoring and destroying it",
                    ],
                    ["Type of personal data", "Whatever you place in the workspace: we neither select nor inspect it, so you determine it entirely"],
                    ["Categories of data subjects", "Determined by you; typically your own users, customers, employees or test data"],
                    ["Our role", "Processor, acting only on your instructions"],
                ],
            },
        },
        {
            heading: "What we undertake",
            paragraphs: ["As your processor we will:"],
            list: [
                "Process the data only on your documented instructions. Your instructions are: run the machine as the service describes. Creating, starting, stopping, restoring and destroying it are those instructions carried out. We will tell you if we believe an instruction breaches data protection law.",
                "Not access the contents of your workspace. The platform provides us no path into a running machine, and we will not build one: including to respond to an abuse report, which we answer by stopping or destroying the machine instead.",
                "Bind everyone with any access to our systems to confidentiality.",
                "Keep the security measures described below, and not weaken them for the duration of this agreement.",
                "Use only the sub-processors listed on our sub-processors page, tell you before adding or replacing one, and give you a chance to object: your remedy if you object is to stop using the hosted sandbox and delete it.",
                "Help you respond to data subject requests. Since we cannot read the workspace, that help is practical rather than substantive: we cannot find, export or erase an individual's data inside your machine, and you must do that yourself with the access you have.",
                "Help you with security, breach notification and impact assessments under Articles 32 to 36, so far as our role allows, and tell you without undue delay if we learn of a breach affecting data we process for you.",
                "Delete the data at the end: destroying the sandbox destroys the machine and its disk immediately. Our infrastructure provider's automatic snapshots of that disk then expire on their own schedule, currently five days, which is when erasure is complete. We keep no copy of our own and run no backup service.",
                "Give you the information you need to demonstrate compliance with Article 28, and accept an audit: in practice, answering your questions and passing on what our infrastructure provider publishes, since we cannot audit the inside of your own machine.",
            ],
        },
        {
            heading: "What you undertake",
            paragraphs: [
                "You decide what goes into the workspace, and you are the controller for it. You confirm that you have a lawful basis for the personal data you put there, that you have given the notices your own data subjects are owed, and that your instructions to us comply with data protection law.",
                "Given that we run no backup service and cannot see inside, you are responsible for your own copies: desktop sync mirrors the workspace to your own computer if you want one, for your own retention decisions inside the workspace, and for judging whether a free, best-effort hosted machine is an appropriate place for the data you are considering putting on it. Special category data under Article 9 is your call to make and your risk to carry.",
            ],
        },
        {
            heading: "Security measures",
            paragraphs: ["The technical and organisational measures we maintain (GDPR Art. 32):"],
            list: [
                "Each hosted sandbox is a separate machine, with its own disk, in its own private network at our infrastructure provider. Two users' sandboxes never share a machine, a disk or a network.",
                "The machine is reachable only through a tunnel provisioned for that sandbox; nothing on it is exposed by us to the public internet by default.",
                "Traffic between your browser and your sandbox is encrypted in transit.",
                "Access to a sandbox is bound at first connection to the Google identity that created it. Connection tokens are stored encrypted in our database.",
                "No standing access path exists from the platform into a running machine, which is a structural limit rather than a policy one.",
                "Access to our own production systems is limited to the operator, over authenticated channels.",
                "Deletion is immediate: destroying the sandbox destroys the machine and the disk together. The only residue is our provider's automatic disk snapshots, which we neither read nor restore and which expire on their retention schedule.",
                "Disks at our infrastructure provider are encrypted at rest by that provider.",
            ],
        },
        {
            heading: "Sub-processors and transfers",
            paragraphs: [
                "The current list, with what each does and where, is on our sub-processors page. The one that matters here is Fly.io, which provides the machine and disk.",
                "Where you provision a hosted sandbox from the EEA, the UK or Switzerland, the machine and disk are created in the European Union and its contents are not transferred out of the EU by us. Where a transfer to a provider outside the EEA does occur, it is covered by the EU–US Data Privacy Framework or by Standard Contractual Clauses under that provider's data processing agreement.",
            ],
        },
        {
            heading: "Liability and precedence",
            paragraphs: [
                "The liability provisions of the Terms of Service apply to this agreement. In case of conflict between this agreement and the Terms on the processing of personal data, this agreement prevails. It is governed by Polish law.",
                `If you need this agreement as a signed document, or your organisation requires its own form, write to ${LEGAL_CONTACT_EMAIL}.`,
            ],
        },
    ],
};

/* Third-party works whose licences ask for credit. Persona avatars use the Adventurer style, a set of
 * illustrated face components drawn by Lisa Wischofsky and remixed by DiceBear under CC BY 4.0, which
 * requires "appropriate credit" and a link to the licence. This page satisfies that, and is the single
 * place to add future attributions if another dependency asks for one. */
export const creditsDoc: LegalDoc = {
    title: "Credits",
    intro: "intentic uses the following open-source works that ask to be credited.",
    sections: [
        {
            heading: "Persona avatars",
            paragraphs: [
                `Persona faces are generated with DiceBear (dicebear.com), an open-source avatar library by Florian Körner, MIT-licensed.`,
                `The artwork is the "Adventurer" style, a remix of the Adventurer illustration set (figma.com/community/file/1184595184137881796) by Lisa Wischofsky, licensed under Creative Commons Attribution 4.0 International (CC BY 4.0, creativecommons.org/licenses/by/4.0/). Changes were made: the illustrations are assembled programmatically from the style's component variants rather than used as-is.`,
            ],
        },
    ],
};

export const subprocessorsDoc: LegalDoc = {
    title: "Sub-processors",
    intro: `Effective ${LEGAL_VERSION}. The providers we use to run the intentic platform, what each one does, and where it processes data. We announce changes here before they take effect.`,
    sections: [
        {
            heading: "The list",
            paragraphs: [],
            table: {
                columns: ["Provider", "What it does", "Where", "Transfer safeguard"],
                rows: [
                    [
                        "Fly.io, Inc. (US)",
                        "Runs the virtual machine and disk of a sandbox we host, and only those",
                        "European Union (Stockholm) for users in the EEA, UK and Switzerland; United States (Ashburn) for everyone else",
                        "Standard Contractual Clauses",
                    ],
                    [
                        "Cloudflare, Inc. (US)",
                        "Website delivery, DNS, and the tunnel that makes a sandbox reachable from your browser",
                        "Global edge network",
                        "Data Privacy Framework and Standard Contractual Clauses",
                    ],
                    [
                        "Google Ireland Ltd / Google LLC",
                        "Sign-in, the fonts the website loads, and the Gemini models that serve the free trial",
                        "European Union and United States",
                        "Data Privacy Framework",
                    ],
                    [
                        "Stripe Payments Europe Ltd (IE)",
                        "Membership payments, invoicing and creator payouts, including the identity and tax details a payout account needs",
                        "European Union and United States",
                        "Data Privacy Framework and Standard Contractual Clauses",
                    ],
                ],
            },
        },
        {
            heading: "Not on this list, deliberately",
            paragraphs: [
                "Your own model provider, Anthropic, or whoever you configure with your own key, is not our sub-processor. Your sandbox talks to them directly under your own agreement, and that traffic never passes through us. The one exception is the free trial, where the model calls are ours: that is why Google appears above.",
                "We use no analytics, advertising, error-tracking or customer-messaging providers, so none appear here.",
            ],
        },
        {
            heading: "Changes",
            paragraphs: [
                "If we add or replace a sub-processor, we update this page and announce it in the app before the change takes effect, so customers relying on our Data Processing Agreement can object. Objecting means you can stop using the hosted sandbox and delete it.",
            ],
        },
    ],
};
