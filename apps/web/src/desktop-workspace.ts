export type DesktopState = 'connecting' | 'connected' | 'disconnected' | 'error' | 'expired';
export const desktopStateLabels: Record<DesktopState, string> = {
  connecting: '连接中', connected: '已连接', disconnected: '已断开', error: '连接失败', expired: '会话已失效',
};
export function retainDesktopConnections(current: string[], active: string, available: string[]) {
  return [...current.filter(id => id !== active && available.includes(id)), active].filter(id => available.includes(id)).slice(-3);
}
export function remainingDesktopTime(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
