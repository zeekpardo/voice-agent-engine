/**
 * Diamond Realty Group — AI lender follow-up workflow (local demo).
 *
 * This file is the CONSUMING-APP side of the engine boundary (spec §11-A):
 * the state machine, the timers, and the email steps live HERE. The engine
 * only contributes the voice channel and structured outcomes.
 *
 * Timers are compressed for the demo: 1 workflow-hour = TIMESCALE seconds.
 */

export type BuyerStatus =
	| "assigned" // assigned to lender, awaiting first status check
	| "contacted" // lender confirmed contact/appointment; awaiting docs
	| "docs_submitted" // file complete; awaiting approval decision
	| "approved" // pre-approved → Miguel notified, workflow done
	| "stalled"; // no response after 2 follow-ups → escalated

export interface LogEntry {
	ts: string;
	kind: "email" | "call" | "status" | "tool" | "escalation";
	title: string;
	body?: string;
}

export interface Buyer {
	id: string;
	name: string;
	phone: string;
	email: string;
	property: string;
	lenderName: string;
	lenderEmail: string;
	status: BuyerStatus;
	followupsWithoutResponse: number;
	/** epoch ms when the next scheduled action fires; null = nothing pending */
	nextActionAt: number | null;
	nextActionLabel: string | null;
	/** open voice session the demo user can answer as the lender */
	pendingCall: { callId: string; joinUrl: string; createdAt: string } | null;
	log: LogEntry[];
}

/** 1 workflow-hour = this many demo-seconds (24h → 48s with default 2). */
export const TIMESCALE = Number(process.env.TIMESCALE ?? 2);

export const hours = (h: number) => h * TIMESCALE * 1000;

const SIGNATURE = "Miguel A. Hernandez\nDiamond Realty Group\n661-778-9135";

/** The workflow's email templates, verbatim from Miguel's playbook. */
export const emails = {
	statusCheck24h: (b: Buyer) => ({
		title: `📧 → ${b.lenderName} — "Status Update Requested – Buyer Approval – ${b.name}"`,
		body:
			`Hi ${b.lenderName},\n\nI'm following up regarding the buyer we assigned yesterday:\n\n` +
			`Buyer: ${b.name}\nPhone: ${b.phone}\nEmail: ${b.email}\nProperty of Interest: ${b.property}\n\n` +
			`Can you please confirm whether contact has been made and if an appointment has been scheduled?\n\n` +
			`Please include your assistant and any team members involved in the approval process in your reply.\n\nThank you,\n${SIGNATURE}`,
	}),
	followUp48h: (b: Buyer) => ({
		title: `📧 → ${b.lenderName} — "Follow-Up – Buyer Contact Status – ${b.name}"`,
		body:
			`Hi ${b.lenderName},\n\nJust checking in on the status of:\n\nBuyer: ${b.name}\n\n` +
			`Has contact been made and has the buyer scheduled their approval appointment?\n\nThank you,\n${SIGNATURE}`,
	}),
	docsCheck72h: (b: Buyer) => ({
		title: `📧 → ${b.lenderName} — "Document Status Check – ${b.name}"`,
		body:
			`Hi ${b.lenderName},\n\nFollowing up on ${b.name}'s recent appointment.\n\nCan you please confirm:\n` +
			`• Have all required documents been submitted?\n• Is the file complete for underwriting review?\n\nThank you,\n${SIGNATURE}`,
	}),
	approvalCheck48h: (b: Buyer) => ({
		title: `📧 → ${b.lenderName} — "Approval Status Request – ${b.name}"`,
		body:
			`Hi ${b.lenderName},\n\nChecking in regarding ${b.name}.\n\nHave they been officially pre-approved at this time?\n\nThank you,\n${SIGNATURE}`,
	}),
	buyerApproved: (b: Buyer) => ({
		title: `📧 → miguel@diamondrealtygroup.net — "Buyer Approved – Ready to Schedule Showings – ${b.name}"`,
		body:
			`Miguel,\n\nGood news — the lender has confirmed that:\n\nBuyer: ${b.name}\nStatus: Approved\n\n` +
			`Buyer is now cleared to begin viewing properties.\nYou may proceed with scheduling showings.\n\n– AI Assistant\nDiamond Realty Group`,
	}),
	escalation: (b: Buyer) => ({
		title: `📧 → miguel@diamondrealtygroup.net — "⚠️ Escalation – No Lender Response – ${b.name}"`,
		body:
			`Miguel,\n\n${b.lenderName} has not confirmed progress for ${b.name} after 2 follow-ups.\n` +
			`Status marked STALLED — manual intervention recommended.\n\n– AI Assistant`,
	}),
};

/**
 * The agent the engine runs for these calls. Everything vertical lives in
 * instructions + extract fields — the engine itself stays use-case neutral.
 */
export const LENDER_AGENT_CONFIG = {
	name: "Lender Follow-Up Caller",
	description: "Diamond Realty Group — calls lender offices to check buyer approval progress",
	instructions:
		"You are a professional, courteous assistant calling on behalf of Miguel Hernandez at " +
		"Diamond Realty Group. You are calling {{lender_name}}'s office regarding buyer {{buyer_name}} " +
		"(phone {{buyer_phone}}, interested in {{property_address}}). Current stage: {{stage}}.\n\n" +
		"Your goals, in order: (1) confirm whether the lender has made contact with the buyer, " +
		"(2) whether an approval appointment is scheduled or has happened, (3) whether all documents " +
		"have been submitted and the file is complete, (4) whether the buyer is officially pre-approved, " +
		"and (5) the expected timeline for whatever step is pending.\n\n" +
		"Rules: never assume approval without explicit confirmation. Be brief and warm — this is a " +
		"phone call between professionals. If the person confirms a status update, use the log_status " +
		"tool to record it immediately. Close by thanking them and confirming when you'll follow up next.",
	greeting:
		"Hi, this is the assistant for Miguel Hernandez at Diamond Realty Group — I'm calling about " +
		"buyer {{buyer_name}}. Do you have a quick moment?",
	language: "en",
	tts: { voice: "rex" },
	llm: { model: "grok-4-fast", temperature: 0.3, maxTokens: 300 },
	timeouts: { maxCallSeconds: 600, silenceHangupSeconds: 30, noAnswerSeconds: 25 },
	compliance: { aiDisclosure: true },
	postCall: {
		summarize: true,
		extract: {
			contact_made: "true/false/unknown — did the lender confirm they have contacted the buyer?",
			appointment_scheduled:
				"true/false/unknown — is a buyer approval appointment scheduled or completed?",
			docs_submitted:
				"true/false/unknown — did the lender confirm all required documents are submitted?",
			approved:
				"true/false/unknown — is the buyer OFFICIALLY pre-approved? Only true if explicitly confirmed.",
			expected_timeline: "short free text — expected timeline the lender gave, or unknown",
		},
	},
};
