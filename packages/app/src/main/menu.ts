import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { Windows } from './windows.js';

/** The native menu (docs/05 §2). Items navigate the window; they never bypass a screen's checks. */
export function installMenu(
  windows: Windows,
  devTools: boolean,
  host: { openLogs(): Promise<void>; about(): void },
): void {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New run', accelerator: 'CmdOrCtrl+N', click: () => windows.menu('new-run') },
        {
          label: 'New work item',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => windows.menu('new-item'),
        },
        { type: 'separator' },
        {
          label: 'Open repo…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            const win = windows.focused();
            const id = win?.webContents.id;
            if (id !== undefined) void windows.pick(id);
            else void windows.open(null);
          },
        },
        { type: 'separator' },
        { role: 'close' },
        ...(mac ? [] : [{ label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Theme',
          submenu: [
            { label: 'System', click: () => windows.menu('theme-system') },
            { label: 'Light', click: () => windows.menu('theme-light') },
            { label: 'Dark', click: () => windows.menu('theme-dark') },
          ],
        },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        ...(devTools ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Help page', click: () => windows.menu('help') },
        { label: 'Open log folder', click: () => void host.openLogs() },
        { label: 'About advpipe', click: () => host.about() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
