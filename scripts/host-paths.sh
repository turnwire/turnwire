#!/usr/bin/env bash
# Source only: resolve XDG defaults without inspecting, creating or migrating data.
turnwire_resolve_paths() {
  if [[ ${TURNWIRE_HOME+x} ]]; then
    printf '%s\n' 'TURNWIRE_HOME has been removed; use TURNWIRE_STATE_HOME, TURNWIRE_CONFIG_HOME, TURNWIRE_DATA_HOME and TURNWIRE_CACHE_HOME.' >&2
    return 1
  fi
  local config state data cache
  case ${XDG_CONFIG_HOME-} in /*) config=$XDG_CONFIG_HOME ;; *) config=$HOME/.config ;; esac
  case ${XDG_STATE_HOME-} in /*) state=$XDG_STATE_HOME ;; *) state=$HOME/.local/state ;; esac
  case ${XDG_DATA_HOME-} in /*) data=$XDG_DATA_HOME ;; *) data=$HOME/.local/share ;; esac
  case ${XDG_CACHE_HOME-} in /*) cache=$XDG_CACHE_HOME ;; *) cache=$HOME/.cache ;; esac
  TURNWIRE_UNITS_DIR=$config/systemd/user
  export TURNWIRE_STATE_HOME=${TURNWIRE_STATE_HOME:-$state/turnwire}
  export TURNWIRE_CONFIG_HOME=${TURNWIRE_CONFIG_HOME:-$config/turnwire}
  export TURNWIRE_DATA_HOME=${TURNWIRE_DATA_HOME:-$data/turnwire}
  export TURNWIRE_CACHE_HOME=${TURNWIRE_CACHE_HOME:-$cache/turnwire}
  TURNWIRE_RUNTIME_DIR=$TURNWIRE_DATA_HOME/runtime
  TURNWIRE_CACHE_DIR=$TURNWIRE_CACHE_HOME
  TURNWIRE_NODE=$TURNWIRE_RUNTIME_DIR/node/bin/node
  export TURNWIRE_DSH_HOME=${TURNWIRE_DSH_HOME:-$TURNWIRE_STATE_HOME/dsh}
  export TURNWIRE_DSH_ENV_FILE=${TURNWIRE_DSH_ENV_FILE:-$TURNWIRE_CONFIG_HOME/dsh.env.json}
  export TURNWIRE_DSH_ENTRY=${TURNWIRE_DSH_ENTRY:-$TURNWIRE_RUNTIME_DIR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js}
}
