#!/usr/bin/env bash
# Helm launcher — bash version of start-helm.cmd. Run it (or double-click it
# where .sh files open in a terminal) to start the server and watch its logs.
# Like the .cmd, it opens Helm in its OWN app window (no tabs, no address bar)
# once the server answers, and only opens that window if Helm is already up.
cd "$(dirname "$0")" || exit 1
root=$PWD
url="http://127.0.0.1:${PORT:-7777}"

# Waits for /health, then opens Helm as a chrome-less app window. On Windows
# that is exactly start-helm.cmd's --open step (Edge → Chrome → Brave, plus the
# notch), so reuse it rather than keep a second copy of that browser hunt.
open_app() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) (cd "$root" && cmd //c '.\start-helm.cmd' --open) ;;
    *)
      for i in $(seq 1 120); do
        curl -fs -m 2 "$url/health" >/dev/null 2>&1 && break
        sleep 0.5
      done
      for b in google-chrome chromium chromium-browser microsoft-edge brave-browser \
               "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
               "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
               "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
        if command -v "$b" >/dev/null 2>&1; then
          "$b" "--app=$url" --window-size=1500,950 >/dev/null 2>&1 &
          return
        fi
      done
      # No Chromium browser: a normal tab in the default browser.
      if [ "$(uname -s)" = Darwin ]; then open "$url"; else xdg-open "$url" >/dev/null 2>&1; fi ;;
  esac
}

# Already running? A second server cannot bind the port — just open the window.
if curl -fs -m 2 "$url/health" >/dev/null 2>&1; then
  echo "Helm is already running - opening $url"
  open_app
  exit 0
fi

open_app &
echo "Starting Helm server on $url  (Ctrl+C to stop)"
echo
cd server && npm start
code=$?
echo
echo "=== Helm server stopped (exit code $code). Press Enter to close. ==="
read -r
