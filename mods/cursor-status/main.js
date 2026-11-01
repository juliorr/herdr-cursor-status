// Cursor Status: Cursor Agent CLI terminals report their status to Herdr.
//
// The work is done by status.mjs, run by Cursor's own hooks
// (~/.cursor/hooks.json), so it works while this mod, and the app, are
// closed. This file only makes the folder a valid Herdr mod; it shows nothing.

import { View, div } from "gpui-kit";

export default class CursorStatus extends View {
  render(cx) {
    return div().id("cursor-status");
  }
}
