/** Whether a conversation stops in the middle of something, judging by its last entry. */

/**
 * True when the last thing in the conversation is something the agent still owed an answer to: a message from the user
 * that was never answered, a tool result the model never saw, or tool calls that were never carried out. That is how
 * a chat looks when the host died while it was working.
 *
 * It is only meaningful while the agent is not running; the caller checks that.
 */
export function endsUnfinished(entry: unknown): boolean {
	const e = entry as { type?: string; message?: { role?: string; stopReason?: string } } | null | undefined;
	if (!e || e.type !== "message" || !e.message) return false;
	switch (e.message.role) {
		case "user":
		case "toolResult":
			return true;
		case "assistant":
			// Tool calls that were asked for and not run. A reply that errored or was stopped on purpose is visible as such.
			return e.message.stopReason === "toolUse";
		default:
			return false;
	}
}

export const CONTINUE_CHAT = "Carry on from where you left off. The previous request was cut off when the host restarted. If a command was interrupted, check what state it left behind before running it again.";
