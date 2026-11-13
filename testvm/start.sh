#!/bin/sh
cd "$(dirname "$0")"
exec qemu-system-x86_64 -accel tcg -m 256 -smp 2 \
  -drive file=openwrt-25.12.6-x86-64-generic-ext4-combined.img,format=raw,if=virtio \
  -netdev user,id=lan,net=10.0.2.0/24,hostfwd=tcp:127.0.0.1:8081-10.0.2.15:80,hostfwd=tcp:127.0.0.1:2223-10.0.2.15:22 \
  -device virtio-net-pci,netdev=lan \
  -netdev user,id=wan -device virtio-net-pci,netdev=wan \
  -serial unix:serial.sock,server,nowait -monitor none -display none -pidfile qemu.pid
