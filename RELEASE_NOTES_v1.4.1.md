# AI Mobile 1.4.1

AI Mobile 1.4.1 fixes the first live Director-CFO activation defect found in a production project.

The passive inventory already measured free disk under `worktreeStorage.freeMb`, but the budget ledger read only `machine.freeDiskMb`. That mismatch made a valid context-scout package fail closed as `machine-free-disk-unknown` despite more than 47 GB being available.

This patch accepts the authoritative worktree-storage measurement as the disk-capacity fallback, preserves the configured free-space floor, and adds regression coverage using the real installed inventory structure.
