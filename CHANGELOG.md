# Changelog

Notable changes to the editor, the desktop app, the part SDK and the project format. A breaking
change can land in any release (see the README's
[Project Status](README.md#project-status)); breaking changes are listed first and marked as such.

## 0.1.0 (Unreleased)

The first public source release. The [README](README.md#features) lists what it includes. It also includes:

- A desktop app for Windows (a signed installer) and Linux (a `.deb` and an AppImage).
- Project tests: JSON regression tests for a project's control logic (`npm run test-project`).
- An external PLC link over SLMP (MELSEC 3E binary frames): a Q, L, iQ-R or iQ-F CPU reads and
  writes the scene's tags as its own devices (`M10`, `Y0`, `D100`, `B1A`, `W10`, `TN5`), with a
  connection guide ([guides/slmp/](guides/slmp/)).
- Part Editor: **Split into pieces** turns an imported model's nodes into their own nodes without importing it
  again, and a revolute joint's **Pivot** (with **Pivot at centre**) sets the point it turns about. A split piece
  can be merged back, any node can change **Parent** in place, **Test motion** sweeps a joint between its limits
  and **Position** drags it by hand, and a revolute joint can **spin endlessly** at a set rpm (a wrapping servo).
  A joint's **PLC control** can be set to **Two positions**, which writes a behavior with a BOOL command tag, two
  end-position tags and a stroke time, so a PLC moves the joint with no code in the part, and a spinning joint's to
  **Spin**, with a run tag, a speed tag in rpm and an at-speed tag.
  Editing a joint in the panel no longer drops its `servo`, `rest`, `cosmetic` or param-driven limits.
- Each node of an imported model is drawn by one mesh link, the nearest that keeps it (`keepNode`), so a split
  piece needs no `hideNodes` entry on the model, a piece can be split from inside another, and deleting a piece
  gives it back to the model (Part SDK level 13).
- Scene Properties splits **Units** into **Speed** and **Length**. Speed is m/s or FPM, which its conveyors' speed
  tags carry. Length shows every length in metres, millimetres or inches, display only. A scene saved with Units
  **Metric (mm, m/s)** opens as Metric (m/s) with Length in millimetres.
- **PLC connections…** beside a controller: its variables, grouped by program or list, beside the scene's machines and
  their tag fields. They come from the simulator's own program, or are read from a TwinCAT PLC over ADS, a Logix
  controller over EtherNet/IP or an OPC UA server. Picking a field and a variable wires them, writing the name into the
  field as the Inspector's Comms group would.

Earlier development history is not part of this repository.
