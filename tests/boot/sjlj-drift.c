/*
 * Emscripten's setjmp/longjmp with Asyncify, the way QEMU-Wasm's vCPU
 * thread uses them (Emscripten 3.1.50: longjmp emulated in JavaScript,
 * -sASYNCIFY, pthreads), without QEMU.
 *
 * exec_setjmp() is QEMU's cpu_exec_setjmp(): setjmp(), then exec_loop()
 * (cpu_exec_loop()), which goes down a few frames, lets Asyncify unwind
 * and rewind the thread's stack there (emscripten_sleep(0), as QEMU-Wasm's
 * JIT does at its cap, or a fiber swap, as its coroutines do), comes back
 * up and calls longjmp() (cpu_loop_exit()).  The landing calls exec_loop()
 * again, as QEMU does until cpu_exec() returns.
 *
 *   node sjlj-drift.js <none|sleep|fiber> <fix> <stack KiB> <rounds> <fill>
 *
 *   fix    1: put the stack pointer back after the landing (QEMU patch 0016)
 *   stack  the thread's C stack in KiB, 0 for Emscripten's default (64)
 *   fill   the byte the frames below write: 0x01 makes a valid address in
 *          the 64 MiB memory, 0xa5 does not
 *
 * After each landing it prints how far the C stack pointer is below where
 * it was at setjmp(), and how far above the end of the thread's stack.
 * Below that end lie the thread's TSD and TLS blocks; the last words of the
 * TLS are Emscripten's __THREW__ and __threwValue.
 *
 * For the QEMU crash hunt (.github/workflows/qemu-crash.yml, mode=sjlj).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
#include <emscripten.h>
#include <emscripten/fiber.h>
#include <emscripten/stack.h>
#include <pthread.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* compiler-rt's stack_ops.S; sets __stack_pointer (as patch 0016 does). */
void set_stack_pointer(uintptr_t sp) __asm__("stackRestore");

static jmp_buf env;
static int mode;            /* 0 none, 1 emscripten_sleep, 2 fiber swap */
static int fix;
static int rounds;
static int fill;
static uintptr_t stack_end;

static emscripten_fiber_t main_fiber, co_fiber;
static char co_stack[16384] __attribute__((aligned(16)));
static char co_astack[16384] __attribute__((aligned(16)));
static char main_astack[65536] __attribute__((aligned(16)));

static void co_entry(void *arg)
{
    for (;;) {
        emscripten_fiber_swap(&co_fiber, &main_fiber);
    }
}

/* Four small frames on the C stack, each filled with the fill byte. */
__attribute__((noinline)) static void go_down(int depth)
{
    volatile unsigned char pad[64];
    int i;

    for (i = 0; i < (int)sizeof(pad); i++) {
        pad[i] = fill;
    }
    if (depth > 0) {
        go_down(depth - 1);
    } else if (mode == 1) {
        emscripten_sleep(0);
    } else if (mode == 2) {
        emscripten_fiber_swap(&main_fiber, &co_fiber);
    }
    pad[depth] = fill;
}

__attribute__((noinline)) static int exec_loop(void)
{
    go_down(3);
    longjmp(env, 1);
}

__attribute__((noinline)) static int exec_setjmp(void)
{
    volatile int n = 0;
    const uintptr_t sp = emscripten_stack_get_current();

    if (setjmp(env) != 0) {
        uintptr_t now;

        if (fix) {
            set_stack_pointer(sp);
        }
        now = emscripten_stack_get_current();
        n++;
        printf("round %d: stack pointer %ld bytes below where setjmp() was, "
               "%ld above the stack's end\n",
               n, (long)(sp - now), (long)now - (long)stack_end);
        fflush(stdout);
        if (n >= rounds) {
            return n;
        }
    }
    return exec_loop();
}

static void *thread_main(void *arg)
{
    int n;

    stack_end = emscripten_stack_get_end();
    printf("thread: %lu bytes of C stack, %lu in use\n",
           (unsigned long)(emscripten_stack_get_base() - stack_end),
           (unsigned long)(emscripten_stack_get_base() -
                           emscripten_stack_get_current()));
    if (mode == 2) {
        emscripten_fiber_init_from_current_context(&main_fiber, main_astack,
                                                   sizeof(main_astack));
        emscripten_fiber_init(&co_fiber, co_entry, NULL, co_stack,
                              sizeof(co_stack), co_astack, sizeof(co_astack));
    }
    n = exec_setjmp();
    printf("SJLJ RESULT: %d rounds, no crash\n", n);
    fflush(stdout);
    return NULL;
}

int main(int argc, char **argv)
{
    pthread_attr_t attr;
    pthread_t t;
    size_t kib;

    if (argc < 6) {
        fprintf(stderr, "usage: sjlj-drift <none|sleep|fiber> <fix> "
                "<stack KiB> <rounds> <fill>\n");
        return 2;
    }
    mode = !strcmp(argv[1], "sleep") ? 1 : !strcmp(argv[1], "fiber") ? 2 : 0;
    fix = atoi(argv[2]);
    kib = strtoul(argv[3], NULL, 0);
    rounds = atoi(argv[4]);
    fill = (int)strtol(argv[5], NULL, 0);

    pthread_attr_init(&attr);
    if (kib) {
        pthread_attr_setstacksize(&attr, kib * 1024);
    }
    if (pthread_create(&t, &attr, thread_main, NULL) != 0) {
        fprintf(stderr, "pthread_create failed\n");
        return 1;
    }
    pthread_join(t, NULL);
    return 0;
}
