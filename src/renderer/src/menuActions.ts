import { createContext, useContext, useEffect, useRef } from 'react'
import type { MenuCommand } from '../../shared/menuCommands'

export type RegisterMenuAction = (commands: readonly MenuCommand[], run: (command: MenuCommand) => void) => () => void

export const MenuActionsContext = createContext<RegisterMenuAction | null>(null)

export function useMenuActions<T extends MenuCommand>(
  commands: readonly T[],
  enabled: boolean,
  run: (command: T) => void
): void {
  const register = useContext(MenuActionsContext)
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    if (enabled) return register?.(commands, (command) => runRef.current(command as T))
  }, [register, commands, enabled])
}
