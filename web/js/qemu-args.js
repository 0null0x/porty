// Builds the guest kernel command line and the QEMU argument vector.
// Pure functions (no DOM): shared by the page and by tests/native-e2e.sh.
// SPDX-License-Identifier: GPL-2.0-or-later

// 32 bpp modes offered by the VGA BIOS QEMU ships for "-vga std" (SeaBIOS
// rel-1.16.3, vgasrc/svgamodes.c).  Only these exist for VESA framebuffer
// drivers (vesafb, uvesafb); the list has no portrait modes.  The kernel's
// "vga=" parameter takes the VBE mode number plus 0x200.
export const VBE_MODES = {
    '640x480': 0x142, '800x600': 0x143, '1024x768': 0x144, '1152x864': 0x14c,
    '1280x720': 0x18f, '1280x768': 0x177, '1280x800': 0x17a, '1280x960': 0x17d,
    '1280x1024': 0x145, '1440x900': 0x180, '1600x900': 0x195, '1920x1080': 0x192,
};

/** The standard VBE mode to use when a VESA driver ends up in charge. */
export function vesaMode(cfg) {
    const asked = `${cfg.width}x${cfg.height}`;
    if (VBE_MODES[asked]) {
        return asked;
    }
    return Math.max(cfg.width, cfg.height) <= 800 ? '800x600' : '1024x768';
}

/**
 * Kernel command line for Android-x86.
 *
 * manifest.cmdline is the distribution's own base command line, copied out
 * of the ISO's isolinux.cfg at build time (for 9.0-r2 it starts with
 * "root=/dev/ram0 androidboot.selinux=permissive").  The rest mirrors
 * Android-x86's own qemu-android launcher ("console=ttyS0 RAMDISK=vdb") and
 * the switches its initrd and init.sh understand:
 *
 *   RAMDISK=<dev>   read ramdisk.img from a block device (initrd/init)
 *   SRC= DATA=      live session, /data on tmpfs (initrd/scripts/2-mount)
 *   SETUPWIZARD=0   skip the first-run wizard (initrd/init)
 *   DPI=<n>         ro.sf.lcd_density (initrd/scripts/4-dpi)
 *   video=WxH       mode for the KMS (bochs-drm) framebuffer; any size
 *   UVESA_MODE=WxH  mode init.sh gives uvesafb when no framebuffer exists;
 *                   must be a VBE mode, so it can differ from video=
 *   nomodeset vga=  gfx=vesa: no KMS, VESA framebuffer like the ISO's
 *                   "VESA mode" boot entry
 */
export function buildKernelCmdline(cfg, manifest) {
    if (cfg.cmdline.length) {
        return cfg.cmdline.join(' ');
    }
    const ramdiskDev = cfg.disk === 'ide' ? 'sr1' : 'vdb';
    const vesa = vesaMode(cfg);
    const words = [
        ...manifest.cmdline.split(/\s+/).filter(Boolean),
        'console=ttyS0',
        // Android's init then runs its root console shell on the serial port
        // (userdebug builds), which is how the boot test asks for
        // sys.boot_completed.
        'androidboot.console=ttyS0',
        `RAMDISK=${ramdiskDev}`,
        'SRC=',
        'DATA=',
    ];
    if (cfg.gfx === 'vesa') {
        words.push('nomodeset', `vga=0x${(VBE_MODES[vesa] + 0x200).toString(16)}`);
    } else {
        words.push(`video=${cfg.width}x${cfg.height}`);
    }
    words.push(`UVESA_MODE=${vesa}`, `DPI=${cfg.dpi}`);
    if (!cfg.setup) {
        words.push('SETUPWIZARD=0');
    }
    words.push(...cfg.append);
    return words.join(' ');
}

// Android's pointing device.  A touchscreen by default: QEMU's virtio
// multitouch device (hw/input/virtio-input-hid.c) has INPUT_PROP_DIRECT and
// the ABS_MT axes, so Android's EventHub and InputReader make it a touch
// screen on the built-in display (bus virtual, so not external); the page
// sends it one finger per slot through ui/wasmfb.c's ring (patch 0020).
// With touch=0 the USB tablet of Android-x86's qemu-android script, which
// Android-x86 drives as a mouse (CursorInputMapper, an arrow on screen).
export const TOUCH_DEVICE = 'virtio-multitouch-pci';
export const TABLET_DEVICE = 'usb-tablet';

/** The pointing device's arguments for a config (none with usb=0). */
export function inputArgs(cfg) {
    if (!cfg.usb) {
        return [];
    }
    return cfg.touch === false ? ['-usb', '-device', TABLET_DEVICE] : ['-device', TOUCH_DEVICE];
}

/**
 * The pointing device an argument vector gives the guest: 'touch',
 * 'tablet' or 'none'.  The page's input follows the machine it runs (a
 * resumed snapshot brings its own arguments).
 */
export function inputDevice(args) {
    const devices = args.filter((a, i) => args[i - 1] === '-device').map((a) => a.split(',')[0]);
    if (devices.includes(TOUCH_DEVICE)) {
        return 'touch';
    }
    return devices.includes(TABLET_DEVICE) ? 'tablet' : 'none';
}

/**
 * @param cfg       result of parseConfig()
 * @param manifest  image/manifest.json
 * @param paths     { bios, kernel, initrd, ramdisk, diskUrl } as QEMU sees them
 */
export function buildQemuArgs(cfg, manifest, paths) {
    const accel = [`tcg`, `tb-size=${cfg.tb}`];
    // QEMU-Wasm sets up its WebAssembly JIT only in the multi-threaded TCG
    // vCPU thread (init_wasm32() in tcg-accel-ops-mttcg.c), which is QEMU's
    // default for x86_64 guests. Never ask for thread=single.
    if (cfg.smp > 1) {
        accel.push('thread=multi');
    }
    // virtio-blk disks by default (what Android-x86's qemu-android uses).
    // disk=ide presents both images as IDE CD-ROMs instead (/dev/sr0 and
    // /dev/sr1, the classic Live-CD path); ide-hd refuses read-only media.
    const ide = cfg.disk === 'ide';
    const bus = ide ? 'ide' : 'virtio';
    const media = ide ? 'cdrom' : 'disk';
    const disk = manifest.disk;
    // What the chunks are (image/manifest.json, scripts/prepare-image.sh):
    // "qcow2", a compressed qcow2 holding the ext4 system image, which QEMU
    // inflates itself (block/qcow2.c on top of block/porty.c); or "raw",
    // the ISO's squashfs as it is (also every manifest before format 2).
    // Read-only either way: the porty driver cannot write, and a clean qcow2
    // opened read-only is never written.
    const diskFormat = disk.format === 'qcow2' ? 'qcow2' : 'raw';

    const args = [
        '-M', 'pc,vmport=off',
        '-cpu', cfg.cpu,
        '-m', `${cfg.mem}M`,
        '-smp', String(cfg.smp),
        '-accel', accel.join(','),
        '-L', paths.bios,

        // Display: std VGA (bochs dispi) + Porty's shared-memory backend.
        '-display', 'wasmfb',
        '-vga', 'std',
        '-global', `VGA.xres=${cfg.width}`,
        '-global', `VGA.yres=${cfg.height}`,

        // Pointing device: a touchscreen, or with touch=0 the USB tablet
        // (absolute pointer) of Android-x86's qemu-android script.
        ...inputArgs(cfg),

        // Time dilation (?timescale=, patch 0011) slows QEMU's virtual
        // clock. The RTC follows the host's clock unless told otherwise,
        // and would then run ahead of every other clock the guest has.
        ...(cfg.timescale > 1 ? ['-rtc', 'base=utc,clock=vm'] : []),

        '-serial', 'mon:stdio',
        '-parallel', 'none',
        '-nic', 'none',

        '-kernel', paths.kernel,
        '-initrd', paths.initrd,
        '-append', buildKernelCmdline(cfg, manifest),

        // Disk 0: the system image, fetched chunk by chunk (block/porty.c).
        '-drive', [
            `if=${bus}`, 'index=0', `media=${media}`, `format=${diskFormat}`, 'read-only=on',
            'file.driver=porty',
            `file.url=${paths.diskUrl.replace(/,/g, ',,')}`,
            `file.size=${disk.size}`,
            `file.chunk-size=${disk.chunk_size}`,
            `file.cache-chunks=${cfg.cache}`,
            `file.parallel=${cfg.parallel}`,
        ].join(','),
        // Disk 1: ramdisk.img, a small file in the in-memory filesystem.
        // (For disk=ide the caller pads it to a multiple of 2048 bytes,
        // the CD-ROM sector size.)
        '-drive', `if=${bus},index=1,media=${media},format=raw,file=${paths.ramdisk}`
            + (ide ? ',read-only=on' : ''),

        ...cfg.qemu,
    ];
    return args;
}
