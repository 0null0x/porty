// Builds the guest kernel command line and the QEMU argument vector.
// Pure functions (no DOM): shared by the page and by tests/native-e2e.sh.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Kernel command line for Android-x86.
 *
 * manifest.cmdline is the distribution's own base command line, copied out
 * of the ISO's isolinux.cfg at build time (for 9.0-r2 it starts with
 * "root=/dev/ram0 androidboot.selinux=permissive").  The rest mirrors
 * Android-x86's own qemu-android launcher ("console=ttyS0 RAMDISK=vdb") and
 * the documented initrd/init.sh switches:
 *
 *   RAMDISK=<dev>   read ramdisk.img from a block device (initrd/init)
 *   SRC= DATA=      live session, /data on tmpfs (initrd/scripts/2-mount)
 *   SETUPWIZARD=0   skip the first-run wizard (initrd/init)
 *   DPI=<n>         ro.sf.lcd_density (initrd/scripts/4-dpi)
 *   video=WxH       mode for the DRM fbdev console; init.sh also falls back
 *                   to it for uvesafb
 *   UVESA_MODE=WxH  uvesafb mode when no KMS framebuffer exists (init.sh)
 *   nomodeset       disable KMS -> "VESA mode", no GPU acceleration
 */
export function buildKernelCmdline(cfg, manifest) {
    if (cfg.cmdline.length) {
        return cfg.cmdline.join(' ');
    }
    const ramdiskDev = cfg.disk === 'ide' ? 'sr1' : 'vdb';
    const mode = `${cfg.width}x${cfg.height}`;
    const words = [
        ...manifest.cmdline.split(/\s+/).filter(Boolean),
        'console=ttyS0',
        `RAMDISK=${ramdiskDev}`,
        'SRC=',
        'DATA=',
        `video=${mode}`,
        `UVESA_MODE=${mode}`,
        `DPI=${cfg.dpi}`,
    ];
    if (cfg.gfx === 'vesa') {
        words.push('nomodeset');
    }
    if (!cfg.setup) {
        words.push('SETUPWIZARD=0');
    }
    words.push(...cfg.append);
    return words.join(' ');
}

/**
 * @param cfg       result of parseConfig()
 * @param manifest  image/manifest.json
 * @param paths     { bios, kernel, initrd, ramdisk, diskUrl } as QEMU sees them
 */
export function buildQemuArgs(cfg, manifest, paths) {
    const accel = [`tcg`, `tb-size=${cfg.tb}`];
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

        // Absolute pointer, as in Android-x86's qemu-android script.
        '-usb',
        '-device', 'usb-tablet',

        '-serial', 'mon:stdio',
        '-parallel', 'none',
        '-nic', 'none',

        '-kernel', paths.kernel,
        '-initrd', paths.initrd,
        '-append', buildKernelCmdline(cfg, manifest),

        // Disk 0: system.sfs, fetched chunk by chunk (block/porty.c).
        '-drive', [
            `if=${bus}`, 'index=0', `media=${media}`, 'format=raw', 'read-only=on',
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
