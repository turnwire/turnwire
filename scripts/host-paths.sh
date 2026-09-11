#!/usr/bin/env bash
# Source only: resolve defaults before creating any directories (no data migration).
turnwire_resolve_paths() {
  local root=$1 config state data cache legacy=false
  DSH_HOME=${TURNWIRE_DSH_HOME:-${DSH_HOME:-}}
  DSH_ENV_FILE=${TURNWIRE_DSH_ENV_FILE:-${DSH_ENV_FILE:-}}
  DSH_ENTRY=${TURNWIRE_DSH_ENTRY:-${DSH_ENTRY:-}}
  case ${XDG_CONFIG_HOME-} in /*) config=$XDG_CONFIG_HOME ;; *) config=$HOME/.config ;; esac
  case ${XDG_STATE_HOME-} in /*) state=$XDG_STATE_HOME ;; *) state=$HOME/.local/state ;; esac
  case ${XDG_DATA_HOME-} in /*) data=$XDG_DATA_HOME ;; *) data=$HOME/.local/share ;; esac
  case ${XDG_CACHE_HOME-} in /*) cache=$XDG_CACHE_HOME ;; *) cache=$HOME/.cache ;; esac
  TURNWIRE_UNITS_DIR=$config/systemd/user
  if [[ -e $root/config/dsh.env.json || -L $root/config/dsh.env.json || -e $root/state || -L $root/state || -e $root/runtime || -L $root/runtime || -e $root/dsh-state || -L $root/dsh-state ]]; then legacy=true; fi
  if $legacy; then
    export TURNWIRE_CONFIG_HOME=${TURNWIRE_CONFIG_HOME:-${TURNWIRE_HOME:-$root/state}} TURNWIRE_DATA_HOME=${TURNWIRE_DATA_HOME:-$root} TURNWIRE_CACHE_HOME=${TURNWIRE_CACHE_HOME:-${TURNWIRE_HOME:-$root/state}}
    TURNWIRE_RUNTIME_DIR=$TURNWIRE_DATA_HOME/runtime
    export TURNWIRE_HOME=${TURNWIRE_HOME:-$root/state} DSH_HOME=${DSH_HOME:-$root/dsh-state} DSH_ENV_FILE=${DSH_ENV_FILE:-$root/config/dsh.env.json}
  else
    if [[ -z ${TURNWIRE_HOME:-} && ( -e $HOME/.turnwire || -L $HOME/.turnwire ) ]]; then export TURNWIRE_HOME=$HOME/.turnwire; fi
    export TURNWIRE_CONFIG_HOME=${TURNWIRE_CONFIG_HOME:-${TURNWIRE_HOME:-$config/turnwire}} TURNWIRE_DATA_HOME=${TURNWIRE_DATA_HOME:-${TURNWIRE_HOME:-$data/turnwire}} TURNWIRE_CACHE_HOME=${TURNWIRE_CACHE_HOME:-${TURNWIRE_HOME:-$cache/turnwire}}
    TURNWIRE_RUNTIME_DIR=$TURNWIRE_DATA_HOME/runtime
    export TURNWIRE_HOME=${TURNWIRE_HOME:-$state/turnwire}
    export DSH_HOME=${DSH_HOME:-$TURNWIRE_HOME/dsh} DSH_ENV_FILE=${DSH_ENV_FILE:-$TURNWIRE_CONFIG_HOME/dsh.env.json}
  fi
  export DSH_ENTRY=${DSH_ENTRY:-$TURNWIRE_RUNTIME_DIR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js}
  TURNWIRE_CACHE_DIR=$TURNWIRE_CACHE_HOME
  TURNWIRE_NODE=$TURNWIRE_RUNTIME_DIR/node/bin/node
  export TURNWIRE_DSH_HOME=$DSH_HOME TURNWIRE_DSH_ENV_FILE=$DSH_ENV_FILE TURNWIRE_DSH_ENTRY=$DSH_ENTRY
}
