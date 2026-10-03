export type SettingsTab = 'project' | 'services' | 'privacy' | 'retention' | 'access' | 'notifications';

const API_BACKED_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set([
  'services',
  'privacy',
  'access',
  'notifications',
]);

export function isApiBackedSettingsTab(tab: SettingsTab): boolean {
  return API_BACKED_SETTINGS_TABS.has(tab);
}
