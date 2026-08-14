#!/usr/bin/env bash
# HK SSH helper: reads command from stdin, runs on HK, filters PQ warning noise.
ssh -p 43891 -i /c/Users/du_ji/.ssh/id_ed25519_xxsx_hk \
    -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 \
    -o StrictHostKeyChecking=accept-new root@100.97.18.59 \
    'bash -s' 2>&1 | grep -v -e 'post-quantum' -e 'store now, decrypt later' -e 'openssh.com/pq' -e '^$'
