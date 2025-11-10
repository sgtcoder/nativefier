import * as path from 'path';

import * as electronGet from '@electron/get';
import electronPackager from 'electron-packager';
import * as fs from 'fs-extra';
import * as log from 'loglevel';

import { convertIconIfNecessary } from './buildIcon';
import {
  getTempDir,
  hasWine,
  isWindows,
  isWindowsAdmin,
} from '../helpers/helpers';
import { useOldAppOptions, findUpgradeApp } from '../helpers/upgrade/upgrade';
import { AppOptions, RawOptions } from '../../shared/src/options/model';
import { getOptions } from '../options/optionsMain';
import { prepareElectronApp } from './prepareElectronApp';

const OPTIONS_REQUIRING_WINDOWS_FOR_WINDOWS_BUILD = [
  'icon',
  'appCopyright',
  'appVersion',
  'buildVersion',
  'versionString',
  'win32metadata',
];

/**
 * For Windows & Linux, we have to copy over the icon to the resources/app
 * folder, which the BrowserWindow is hard-coded to read the icon from
 */
async function copyIconsIfNecessary(
  options: AppOptions,
  appPath: string,
): Promise<void> {
  log.debug('Copying icons if necessary');
  if (!options.packager.icon) {
    log.debug('No icon specified in options; aborting');
    return;
  }

  if (
    options.packager.platform === 'darwin' ||
    options.packager.platform === 'mas'
  ) {
    if (options.nativefier.tray !== 'false') {
      //tray icon needs to be .png
      log.debug('Copying icon for tray application');
      const trayIconFileName = `tray-icon.png`;
      const destIconPath = path.join(appPath, 'icon.png');
      await fs.copy(
        `${path.dirname(options.packager.icon)}/${trayIconFileName}`,
        destIconPath,
      );
    } else {
      log.debug('No copying necessary on macOS; aborting');
    }
    return;
  }

  // windows & linux: put the icon file into the app
  const destFileName = `icon${path.extname(options.packager.icon)}`;
  const destIconPath = path.join(appPath, destFileName);

  log.debug(`Copying icon ${options.packager.icon} to`, destIconPath);
  await fs.copy(options.packager.icon, destIconPath);
}

/**
 * Checks the app path array to determine if packaging completed successfully
 */
function getAppPath(appPath: string | string[]): string | undefined {
  if (!Array.isArray(appPath)) {
    return appPath;
  }

  if (appPath.length === 0) {
    return undefined; // directory already exists and `--overwrite` not set
  }

  if (appPath.length > 1) {
    log.warn(
      'Warning: This should not be happening, packaged app path contains more than one element:',
      appPath,
    );
  }

  return appPath[0];
}

function isUpgrade(rawOptions: RawOptions): boolean {
  if (
    rawOptions.upgrade !== undefined &&
    typeof rawOptions.upgrade === 'string' &&
    rawOptions.upgrade !== ''
  ) {
    rawOptions.upgradeFrom = rawOptions.upgrade;
    rawOptions.upgrade = true;
    return true;
  }
  return false;
}

function trimUnprocessableOptions(options: AppOptions): void {
  if (options.packager.platform === 'win32' && !isWindows() && !hasWine()) {
    const optionsPresent = Object.entries(options)
      .filter(
        ([key, value]) =>
          OPTIONS_REQUIRING_WINDOWS_FOR_WINDOWS_BUILD.includes(key) && !!value,
      )
      .map(([key]) => key);
    if (optionsPresent.length === 0) {
      return;
    }
    log.warn(
      `*Not* setting [${optionsPresent.join(', ')}], as couldn't find Wine.`,
      'Wine is required when packaging a Windows app under on non-Windows platforms.',
      'Also, note that Windows apps built under non-Windows platforms without Wine *will lack* certain',
      'features, like a correct icon and process name. Do yourself a favor and install Wine, please.',
    );
    for (const keyToUnset of optionsPresent) {
      (options as unknown as Record<string, undefined>)[keyToUnset] = undefined;
    }
  }
}

async function createLinuxDesktopLauncher(
  appPath: string,
  appName: string,
  targetUrl: string,
): Promise<void> {
  try {
    const executableName = path.basename(
      (await fs.readdir(appPath)).find((file) => file === appName) ?? appName,
    );
    const iconPath = path.join(appPath, 'resources', 'app', 'icon.png');
    // Use clean name without spaces for WM_CLASS (matches what's set in app/src/main.ts)
    const cleanName = appName.replace(/\s+/g, '');

    const desktopFileContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${appName}
Comment=App for ${targetUrl}
Exec=${path.join(appPath, executableName)} %U
Icon=${iconPath}
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=${cleanName}
StartupNotify=true
Actions=
Keywords=messenger;chat;
X-GNOME-UsesNotifications=true
`;

    const desktopFilePath = path.join(appPath, `${appName}.desktop`);
    await fs.writeFile(desktopFilePath, desktopFileContent);
    await fs.chmod(desktopFilePath, 0o755);

    log.info(`Created desktop launcher at ${desktopFilePath}`);
    log.info(`To install system-wide, run: cp "${desktopFilePath}" ~/.local/share/applications/`);
  } catch (err: unknown) {
    log.warn('Failed to create desktop launcher:', err);
  }
}

async function installLinuxApp(
  appPath: string,
  appName: string,
): Promise<void> {
  try {
    const { spawnSync } = await import('child_process');
    const os = await import('os');

    const optPath = path.join('/opt', appName);
    const homeDir = os.homedir();
    const desktopDir = path.join(homeDir, '.local', 'share', 'applications');
    const desktopFileSrc = path.join(appPath, `${appName}.desktop`);
    const desktopFileDest = path.join(desktopDir, `${appName}.desktop`);

    log.info(`Installing ${appName} to ${optPath}...`);

    // Check if we need sudo
    const needsSudo = process.getuid && process.getuid() !== 0;

    if (needsSudo) {
      // Use sudo to copy to /opt
      const rmResult = spawnSync('sudo', ['rm', '-rf', optPath], { stdio: 'inherit' });
      if (rmResult.status !== 0) {
        log.warn(`Failed to remove old installation at ${optPath}`);
      }

      const cpResult = spawnSync('sudo', ['cp', '-r', appPath, optPath], { stdio: 'inherit' });
      if (cpResult.status !== 0) {
        throw new Error(`Failed to copy app to ${optPath}`);
      }

      // Update ownership
      const uid = process.getuid ? process.getuid() : 1000;
      const gid = process.getgid ? process.getgid() : 1000;
      spawnSync('sudo', ['chown', '-R', `${uid}:${gid}`, optPath], { stdio: 'inherit' });
    } else {
      // Running as root, no sudo needed
      await fs.remove(optPath);
      await fs.copy(appPath, optPath, { preserveTimestamps: true });
    }

    // Update desktop file to point to /opt installation
    const executableName = appName;
    const iconPath = path.join(optPath, 'resources', 'app', 'icon.png');
    const cleanName = appName.replace(/\s+/g, '');

    const updatedDesktopContent = `[Desktop Entry]
Version=1.0
Type=Application
Name=${appName}
Comment=App for ${appName}
Exec=${path.join(optPath, executableName)} %U
Icon=${iconPath}
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=${cleanName}
StartupNotify=true
Actions=
Keywords=messenger;chat;
X-GNOME-UsesNotifications=true
`;

    // Ensure desktop directory exists
    await fs.ensureDir(desktopDir);

    // Write updated desktop file to ~/.local/share/applications
    await fs.writeFile(desktopFileDest, updatedDesktopContent);
    await fs.chmod(desktopFileDest, 0o755);

    log.info(`✅ Installed ${appName} to ${optPath}`);
    log.info(`✅ Desktop launcher installed to ${desktopFileDest}`);
    log.info(`You can now launch ${appName} from your application menu!`);
  } catch (err: unknown) {
    log.warn('Failed to install app to /opt:', err);
    log.info('You can manually copy the app to /opt and the .desktop file to ~/.local/share/applications/');
  }
}

function getOSRunHelp(platform?: string): string {
  if (platform === 'win32') {
    return `the contained .exe file.`;
  } else if (platform === 'linux') {
    return `the contained executable file (prefixing with ./ if necessary)\nA .desktop launcher file has been created in the app folder for your convenience.`;
  } else if (platform === 'darwin') {
    return `the app bundle.`;
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export async function buildNativefierApp(
  rawOptions: RawOptions,
): Promise<string> {
  // early-suppress potential logging before full options handling
  if (rawOptions.quiet) {
    log.setLevel('silent');
  }

  log.warn(
    '\n\n    Hi! Nativefier is minimally maintained these days, and needs more hands.\n' +
      '    If you have the time & motivation, help with bugfixes and maintenance is VERY welcome.\n' +
      '    Please go to https://github.com/nativefier/nativefier and help how you can. Thanks.\n\n',
  );

  log.info('\nProcessing options...');

  // Set default output directory to 'output-apps' if not specified
  if (!rawOptions.out) {
    rawOptions.out = path.join(process.cwd(), 'output-apps');
  }

  let finalOutDirectory = rawOptions.out;

  if (isUpgrade(rawOptions)) {
    log.debug('Attempting to upgrade from', rawOptions.upgradeFrom);
    const oldApp = findUpgradeApp(rawOptions.upgradeFrom as string);
    if (!oldApp) {
      throw new Error(
        `Could not find an old Nativfier app in "${
          rawOptions.upgradeFrom as string
        }"`,
      );
    }
    rawOptions = useOldAppOptions(rawOptions, oldApp);
    if (rawOptions.out === undefined && rawOptions.overwrite) {
      finalOutDirectory = oldApp.appRoot;
      rawOptions.out = getTempDir('appUpgrade', 0o755);
    }
  }
  log.debug('rawOptions', rawOptions);

  const options = await getOptions(rawOptions);
  log.debug('options', options);

  if (options.packager.platform === 'darwin' && isWindows()) {
    // electron-packager has to extract the desired electron package for the target platform.
    // For a target platform of Mac, this zip file contains symlinks. And on Windows, extracting
    // files that are symlinks need Admin permissions. So we'll check if the user is an admin, and
    // fail early if not.
    // For reference
    // https://github.com/electron/electron-packager/issues/933
    // https://github.com/electron/electron-packager/issues/1194
    // https://github.com/electron/electron/issues/11094
    if (!isWindowsAdmin()) {
      throw new Error(
        'Building an app with a target platform of Mac on a Windows machine requires admin priveleges to perform. Please rerun this command in an admin command prompt.',
      );
    }
  }

  log.info('\nPreparing Electron app...');
  const tmpPath = getTempDir('app', 0o755);
  await prepareElectronApp(options.packager.dir, tmpPath, options);

  log.info('\nConverting icons...');
  options.packager.dir = tmpPath;
  convertIconIfNecessary(options);
  await copyIconsIfNecessary(options, tmpPath);

  options.packager.quiet = !rawOptions.verbose;

  log.info(
    "\nPackaging... This will take a few seconds, maybe minutes if the requested Electron isn't cached yet...",
  );
  trimUnprocessableOptions(options);
  electronGet.initializeProxy(); // https://github.com/electron/get#proxies
  const appPathArray = await electronPackager(options.packager);

  log.info('\nFinalizing build...');
  let appPath = getAppPath(appPathArray);

  if (!appPath) {
    throw new Error('App Path could not be determined.');
  }

  if (
    options.packager.upgrade &&
    options.packager.upgradeFrom &&
    options.packager.overwrite
  ) {
    if (options.packager.platform === 'darwin') {
      try {
        // This is needed due to a funky thing that happens when copying Squirrel.framework
        // over where it gets into a circular file reference somehow.
        await fs.remove(
          path.join(
            finalOutDirectory,
            `${options.packager.name ?? ''}.app`,
            'Contents',
            'Frameworks',
          ),
        );
      } catch (err: unknown) {
        log.warn(
          'Encountered an error when attempting to pre-delete old frameworks:',
          err,
        );
      }
      await fs.copy(
        path.join(appPath, `${options.packager.name ?? ''}.app`),
        path.join(finalOutDirectory, `${options.packager.name ?? ''}.app`),
        {
          overwrite: options.packager.overwrite,
          preserveTimestamps: true,
        },
      );
    } else {
      await fs.copy(appPath, finalOutDirectory, {
        overwrite: options.packager.overwrite,
        preserveTimestamps: true,
      });
    }
    await fs.remove(appPath);
    appPath = finalOutDirectory;
  }

  // Create desktop launcher for Linux
  if (options.packager.platform === 'linux' && options.packager.name && options.packager.targetUrl) {
    await createLinuxDesktopLauncher(
      appPath,
      options.packager.name,
      options.packager.targetUrl,
    );

    // Install to /opt and setup desktop launcher
    await installLinuxApp(appPath, options.packager.name);
  }

  const osRunHelp = getOSRunHelp(options.packager.platform);
  log.info(
    `App built to ${appPath}, move to wherever it makes sense for you and run ${osRunHelp}`,
  );

  return appPath;
}
