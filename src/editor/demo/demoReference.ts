// The demo's control written a second time, for the tests only. Nothing in the app imports this module.
//
// The demo ships one program (demoScenes.ts DEMO_PROGRAM), each POU in the language that suits it: PalletTruck, the
// block each pallet truck runs, in Structured Text (it is arithmetic on route rows), and Palletizer, the cell's program,
// in ladder (it is contacts, coils and steps). Each was translated from a twin in the other language, and the twins are
// kept here so the differential tests hold the shipped program to being the same machine, scan for scan
// (demoScenes.test.ts on inputs at random, demoScenesSim.test.ts through the cell's own run):
//   - PalletizerST, the cell's program in Structured Text: with the shipped PalletTruck, the demo all in ST;
//   - PalletTruckLD, the truck block in ladder, driven by PalletizerLD, which is the shipped Palletizer renamed: the
//     demo all in ladder. PalletizerLD is derived from the shipped text, so there is one ladder Palletizer to keep.
// MutingSeq, the curtains' muting block, has no twin: all three call the shipped one, the way a ladder program calls a
// vendor's muting instruction as a box. It is held on its own in demoMuting.test.ts.
//
// How a twin is kept scan-exact (a CASE tests its selector once, a write another test must see gets its own rung) is
// in docs/ladder.md, "The demo".
import type { Controller } from '../../core/controller'
import { AGV_PICK_BASE, AGV_WAY_BASE, COURSES, DEMO_CONTROLLER, DEMO_PROGRAM, RACK_BAY_BASE, RACK_SLOTS, RACK_WAYS, SUPPLY } from './demoScenes'

/** The cell's program in Structured Text: the reference the shipped ladder is compared with. */
const PALLETIZER_ST = `PROGRAM PalletizerST
VAR
  running    : BOOL := TRUE;
  CaseMuting : MutingSeq;
  FeedMuting : MutingSeq;
  OutMuting  : MutingSeq;
  caseClear  : BOOL := TRUE;
  feedClear  : BOOL := TRUE;
  outClear   : BOOL := TRUE;

  InfeedSpeed : REAL := 1.0;
  RunSpeed   : REAL := 1.0;
  ShiftRate  : REAL := 1.0;
  safe       : BOOL;

  Arrival    : R_TRIG;
  rowPhase   : INT;
  rowsPushed : INT;
  turnedFirst : BOOL;
  thisRowTurned : BOOL;
  rowTarget  : INT;
  rowSent    : INT;
  RowPacked  : TON;
  rowDone    : BOOL;
  shifting   : BOOL;
  ShiftPulse : TON;
  Raised     : TON;
  Pushing    : R_TRIG;
  Shifted    : R_TRIG;
  layerDone  : BOOL;

  Step       : INT;
  OutStep    : INT := 100;
  Moving     : BOOL;
  Started    : BOOL;
  InPlace    : TON;
  TurnSettle : TON;
  LoadLeft   : F_TRIG;

  layerIdx   : INT;
  placeIdx   : INT;
  palletFull : BOOL := TRUE;
  picking    : BOOL;

  LineSpeed  : REAL := 0.4;
  FeedSpeed  : REAL := 0.6;
  PalletFeed : BOOL;

  outRun     : BOOL;
  laneRun    : BOOL;
  blocked    : BOOL;

  Truck      : PalletTruck;
  TruckStep  : INT;
  TruckSlot  : INT;
  TruckDone  : BOOL;
  Supply     : PalletTruck;
  MagEmpty   : TON;
  S3Step     : INT;
  S3Slot     : INT;
  S3Done     : BOOL;

  RunLamp    : BOOL;
  BlinkOn    : TON;
  BlinkOff   : TON;
  ready      : BOOL;
  tripCause  : BOOL;
  RunFell    : F_TRIG;
  tripped    : BOOL;
  eStopOk    : BOOL;
END_VAR

eStopOk := EStop AND EStopDock AND EStopGate AND EStopSupply AND EStopOutfeed;
FlexRun := eStopOk;
CaseMuting(Enable := TRUE, Ossd := CaseCurtain, A1 := CaseMuteA1, A2 := CaseMuteA2, MaxTime := T#30s);
caseClear := CaseMuting.Clear;
CaseMuted := CaseMuting.Muted;
FeedMuting(Enable := TRUE, Ossd := FeedCurtain, A1 := FeedMuteA1, A2 := FeedMuteA2, MaxTime := T#30s);
feedClear := FeedMuting.Clear;
FeedMuted := FeedMuting.Muted;
OutMuting(Enable := TRUE, Ossd := OutCurtain, A1 := OutMuteA1, A2 := OutMuteA2, MaxTime := T#30s);
outClear := OutMuting.Clear;
OutMuted := OutMuting.Muted;
running := (Start OR running) AND Stop AND eStopOk AND Guard AND caseClear AND feedClear AND outClear;
safe := running;
ArmEnable := safe;
CycleEnable := safe;

turnedFirst := (layerIdx MOD 2) = 1;
IF turnedFirst THEN
  thisRowTurned := rowPhase = 0;
ELSE
  thisRowTurned := rowPhase = 1;
END_IF;
IF thisRowTurned THEN
  rowTarget := 3;
ELSE
  rowTarget := 2;
END_IF;
Arrival(CLK := BoxAtEye);
IF Arrival.Q THEN
  rowSent := rowSent + 1;
  Cases := Cases + 1;
END_IF;

RowPacked(IN := RowReady AND (rowSent >= rowTarget) AND NOT shifting AND NOT picking, PT := T#1000ms);

rowDone := RowPacked.Q AND (rowsPushed < 2) AND NOT shifting;
shifting := (rowDone OR shifting) AND NOT ShiftPulse.Q;

ShiftPulse(IN := shifting, PT := T#2000ms);

Raised(IN := shifting, PT := T#200ms);

Pushing(CLK := shifting);
IF Pushing.Q AND (rowsPushed = 0) THEN
  rowPhase := 1;
  rowSent := 0;
END_IF;
Shifted(CLK := ShiftPulse.Q);
IF Shifted.Q THEN
  rowsPushed := rowsPushed + 1;
  IF rowsPushed >= 2 THEN
    rowSent := 0;
  END_IF;
END_IF;

layerDone := (rowsPushed >= 2) AND LayerReady;

IF Moving THEN
  IF NOT ArmIdle THEN Started := TRUE; END_IF;
  IF Started THEN ArmExec := FALSE; END_IF;
  IF Started AND ArmIdle THEN Moving := FALSE; END_IF;
END_IF;

InPlace(IN := PalletFeed AND PalletIn, PT := T#800ms);
TurnSettle(IN := OutStep = 115, PT := T#1200ms);
LoadLeft(CLK := LoadOut);

IF safe THEN
  CASE Step OF
    0:  picking := FALSE;
        IF layerDone AND NOT palletFull THEN
          placeIdx := layerIdx;
          ArmCmd := 1; ArmExec := TRUE; Moving := TRUE; Started := FALSE; picking := TRUE; Step := 10;
        END_IF;
    10: IF NOT Moving THEN
          rowPhase := 0;
          rowSent := 0;
          rowsPushed := 0;
          picking := FALSE;
          layerIdx := layerIdx + 1;
          IF layerIdx >= ${COURSES} THEN layerIdx := 0; END_IF;
          ArmCmd := placeIdx + 2; ArmExec := TRUE; Moving := TRUE; Started := FALSE; Step := 20;
        END_IF;
    20: IF NOT Moving THEN
          IF placeIdx >= ${COURSES - 1} THEN
            IF OutStep = 0 THEN
              palletFull := TRUE;
              OutStep := 100;
              Step := 0;
            END_IF;
          ELSE
            Step := 0;
          END_IF;
        END_IF;
  END_CASE;

  CASE OutStep OF
    100: IF NOT LaneFull THEN
           Pallets := Pallets + 1;
           TurnCmd := 0.0; OutStep := 105;
         END_IF;
    105: IF TurnDone THEN outRun := TRUE; OutStep := 106; END_IF;
    106: IF WrapInPos THEN outRun := FALSE; WrapStart := TRUE; OutStep := 107; END_IF;
    107: IF WrapDone THEN WrapStart := FALSE; outRun := TRUE; OutStep := 110; END_IF;
    110: IF TurnEye THEN outRun := FALSE; OutStep := 115; END_IF;
    115: IF TurnSettle.Q THEN
           TurnCmd := -90.0;
           OutStep := 120;
         END_IF;
    120: IF TurnDone THEN laneRun := TRUE; OutStep := 130; END_IF;
    130: IF LaneFull THEN
           laneRun := FALSE;
           TurnCmd := 0.0;
           OutStep := 140;
         END_IF;
    140: IF TurnDone THEN OutStep := 0; END_IF;
  END_CASE;
  IF palletFull AND LoadLeft.Q THEN
    PalletFeed := TRUE;
  END_IF;
  IF PalletFeed AND InPlace.Q THEN
    PalletFeed := FALSE;
    palletFull := FALSE;
  END_IF;
END_IF;

Truck(Enable := safe, Idle := RackIdle, Grant := TRUE,
      Request := LaneFull AND NOT laneRun,
      PickBase := ${AGV_PICK_BASE}, WayBase := ${AGV_WAY_BASE},
      WayOut := ${RACK_WAYS.out}, WayMid := ${RACK_WAYS.mid}, WayIn := ${RACK_WAYS.in},
      DropBase := ${RACK_BAY_BASE}, Slots := ${RACK_SLOTS});
RackCmd := Truck.Cmd; RackExec := Truck.Exec; RackFork := Truck.Fork;
TruckStep := Truck.Step; TruckSlot := Truck.Slot; TruckDone := Truck.Done;

MagEmpty(IN := (MagLevel = 0) AND NOT PalletReady, PT := T#1000ms);
Supply(Enable := safe, Idle := SupplyIdle, Grant := TRUE,
       Request := MagEmpty.Q,
       PickBase := ${SUPPLY.pickBase}, PickStride := ${SUPPLY.pickStride}, WayBase := 0,
       WayOut := 0, WayMid := 0, WayIn := 0,
       DropBase := ${SUPPLY.dropBase}, Slots := ${SUPPLY.slots});
SupplyCmd := Supply.Cmd; SupplyExec := Supply.Exec; SupplyFork := Supply.Fork;
S3Step := Supply.Step; S3Slot := Supply.Slot; S3Done := Supply.Done;

IF safe AND NOT picking THEN
  Infeed := InfeedSpeed;
  RowForm := RunSpeed;
ELSE
  Infeed := 0.0;
  RowForm := 0.0;
END_IF;
IF safe AND shifting AND Raised.Q THEN
  ShiftSpeed := ShiftRate;
ELSE
  ShiftSpeed := 0.0;
END_IF;

SpawnRun := safe AND NOT layerDone AND NOT picking AND (rowSent < rowTarget);
LoadFlex := safe AND NOT FlexFull;

IF safe AND outRun THEN PalletOut := LineSpeed; ELSE PalletOut := 0.0; END_IF;
IF safe AND outRun AND palletFull AND NOT PalletFeed THEN DeckRun := LineSpeed; ELSE DeckRun := 0.0; END_IF;
IF safe AND (outRun OR laneRun) THEN TurnRun := LineSpeed; ELSE TurnRun := 0.0; END_IF;
IF safe AND laneRun THEN Lane := LineSpeed; ELSE Lane := 0.0; END_IF;

PalletLift := safe AND PalletFeed;
IF safe AND PalletFeed AND NOT DispBusy THEN
  PalletInfeed := FeedSpeed;
  PalletXfer := FeedSpeed;
ELSE
  PalletInfeed := 0.0;
  PalletXfer := 0.0;
END_IF;
PalletDispense := safe AND NOT PalletFeed AND NOT PalletReady AND NOT DispBusy;

Turn := safe AND thisRowTurned;
Shift := shifting AND safe;

RunLamp := safe;
blocked := (OutStep = 100) AND LaneFull;
Tower := 0;
IF RunLamp THEN Tower := Tower + 1; END_IF;
IF blocked THEN Tower := Tower + 2; END_IF;
IF (NOT eStopOk) OR (NOT Guard) THEN Tower := Tower + 4; END_IF;

BlinkOn(IN := NOT BlinkOff.Q, PT := T#500ms);
BlinkOff(IN := BlinkOn.Q, PT := T#500ms);
tripCause := (NOT eStopOk) OR (NOT Guard) OR (NOT caseClear) OR (NOT feedClear) OR (NOT outClear);
RunFell(CLK := running);
tripped := ((RunFell.Q AND tripCause) OR tripped) AND NOT running;
ready := NOT running AND tripped AND Stop AND eStopOk AND Guard AND caseClear AND feedClear AND outClear;
StartLamp := RunLamp OR (ready AND BlinkOn.Q);
END_PROGRAM`

/** The truck block in ladder, the twin of the shipped Structured Text one; the interface is the same, pin for pin. */
const PALLET_TRUCK_LD = `FUNCTION_BLOCK PalletTruckLD
VAR_INPUT
  Enable   : BOOL;
  Request  : BOOL;
  Idle     : BOOL;
  Grant    : BOOL;
  PickBase : INT;
  PickStride : INT;
  WayBase  : INT;
  WayOut   : INT;
  WayMid   : INT;
  WayIn    : INT;
  DropBase : INT;
  Slots    : INT;
END_VAR
VAR_OUTPUT
  Cmd  : INT;
  Exec : BOOL;
  Fork : BOOL;
  Want : BOOL;
  Step : INT;
  Slot : INT;
  Done : BOOL;
END_VAR
VAR
  Moving  : BOOL;
  Started : BOOL;
  Send    : INT;
  wi      : INT;
  Lift    : TON;
  Drop    : TON;
  stepNow : INT;
  moreOut : BOOL;
  moreMid : BOOL;
  moreIn  : BOOL;
  bay     : INT;
  homing  : BOOL;
  pk      : INT;
END_VAR
LADDER
  (* a move has started once the truck leaves idle, and is over when it is idle again *)
  |Moving| |/Idle| (S Started);
  |Moving| |Started| (R Exec);
  |Moving| |Started| |Idle| (R Moving);
  (* the forks take their time at the pick and at the drop *)
  EQ(IN1 := Step, IN2 := 20, OUT) |Enable| |/Moving| Lift(IN, PT := T#600ms);
  EQ(IN1 := Step, IN2 := 30, OUT) |Enable| |/Moving| Drop(IN, PT := T#600ms);
  (* no move to send unless a step sends one; every step tests the step as the scan found it *)
  MOVE(IN := -1, OUT => Send);
  MOVE(IN := Step, OUT => stepNow);
  LT(IN1 := wi, IN2 := WayOut, OUT) (moreOut);
  LT(IN1 := wi, IN2 := WayMid, OUT) (moreMid);
  LT(IN1 := wi, IN2 := WayIn, OUT) (moreIn);
  MUL(IN1 := Slot, IN2 := 4, OUT => bay);
  ADD(IN1 := bay, IN2 := DropBase, OUT => bay);
  (* this trip's pick: PickStride 0 picks from the same rows every trip; above 0, each trip's pick starts that many
     rows further on *)
  MUL(IN1 := Slot, IN2 := PickStride, OUT => pk);
  ADD(IN1 := pk, IN2 := PickBase, OUT => pk);
  (* 0: a full lane asks for the aisle *)
  EQ(IN1 := stepNow, IN2 := 0, OUT) |Enable| |Request| |Idle| |/Done| MOVE(IN := 5, OUT => Step) (S Want);
  (* 5-6: the aisle is granted: out along the way, a row at a time *)
  EQ(IN1 := stepNow, IN2 := 5, OUT) |Enable| |Grant| MOVE(IN := 0, OUT => wi) MOVE(IN := 6, OUT => Step);
  EQ(IN1 := stepNow, IN2 := 6, OUT) |Enable| |/Moving| |moreOut| ADD(IN1 := WayBase, IN2 := wi, OUT => Send) ADD(IN1 := wi, IN2 := 1, OUT => wi);
  EQ(IN1 := stepNow, IN2 := 6, OUT) |Enable| |/Moving| |/moreOut| MOVE(IN := pk, OUT => Send) MOVE(IN := 12, OUT => Step);
  (* 12-16: into the pick *)
  EQ(IN1 := stepNow, IN2 := 12, OUT) |Enable| |/Moving| ADD(IN1 := pk, IN2 := 1, OUT => Send) MOVE(IN := 14, OUT => Step);
  EQ(IN1 := stepNow, IN2 := 14, OUT) |Enable| |/Moving| ADD(IN1 := pk, IN2 := 2, OUT => Send) MOVE(IN := 16, OUT => Step);
  EQ(IN1 := stepNow, IN2 := 16, OUT) |Enable| |/Moving| ADD(IN1 := pk, IN2 := 3, OUT => Send) MOVE(IN := 20, OUT => Step);
  (* 20: forks up, then back out *)
  EQ(IN1 := stepNow, IN2 := 20, OUT) |Enable| |/Moving| (S Fork);
  EQ(IN1 := stepNow, IN2 := 20, OUT) |Enable| |/Moving| |Lift.Q| ADD(IN1 := pk, IN2 := 4, OUT => Send) MOVE(IN := 0, OUT => wi) MOVE(IN := 22, OUT => Step);
  (* 22: down the aisle, then to the bay *)
  EQ(IN1 := stepNow, IN2 := 22, OUT) |Enable| |/Moving| |moreMid| ADD(IN1 := WayBase, IN2 := WayOut, IN3 := wi, OUT => Send) ADD(IN1 := wi, IN2 := 1, OUT => wi);
  EQ(IN1 := stepNow, IN2 := 22, OUT) |Enable| |/Moving| |/moreMid| MOVE(IN := bay, OUT => Send) MOVE(IN := 24, OUT => Step);
  (* 24-25: into the bay *)
  EQ(IN1 := stepNow, IN2 := 24, OUT) |Enable| |/Moving| ADD(IN1 := bay, IN2 := 1, OUT => Send) MOVE(IN := 25, OUT => Step);
  EQ(IN1 := stepNow, IN2 := 25, OUT) |Enable| |/Moving| ADD(IN1 := bay, IN2 := 2, OUT => Send) MOVE(IN := 30, OUT => Step);
  (* 30: forks down, then back out *)
  EQ(IN1 := stepNow, IN2 := 30, OUT) |Enable| |/Moving| (R Fork);
  EQ(IN1 := stepNow, IN2 := 30, OUT) |Enable| |/Moving| |Drop.Q| ADD(IN1 := bay, IN2 := 3, OUT => Send) MOVE(IN := 0, OUT => wi) MOVE(IN := 32, OUT => Step);
  (* 32: home along the way; the next load goes to the next bay, and past the last the truck is done *)
  EQ(IN1 := stepNow, IN2 := 32, OUT) |Enable| |/Moving| |moreIn| ADD(IN1 := WayBase, IN2 := WayOut, IN3 := WayMid, IN4 := wi, OUT => Send) ADD(IN1 := wi, IN2 := 1, OUT => wi);
  EQ(IN1 := stepNow, IN2 := 32, OUT) |Enable| |/Moving| |/moreIn| ADD(IN1 := Slot, IN2 := 1, OUT => Slot) MOVE(IN := 0, OUT => Send) MOVE(IN := 40, OUT => Step) (homing);
  GE(IN1 := Slot, IN2 := Slots, OUT) |homing| SUB(IN1 := Slots, IN2 := 1, OUT => Slot) (S Done);
  (* 40: home, and the aisle is free again *)
  EQ(IN1 := stepNow, IN2 := 40, OUT) |Enable| |/Moving| MOVE(IN := 0, OUT => Step) (R Want);
  (* a step that sent a move starts it *)
  GE(IN1 := Send, IN2 := 0, OUT) MOVE(IN := Send, OUT => Cmd) (S Exec) (S Moving) (R Started);
END_LADDER
END_FUNCTION_BLOCK`

/** The shipped Palletizer, renamed and driving the ladder truck block instead of the Structured Text one. */
function palletizerLd(): string {
  const shipped = /^PROGRAM Palletizer\n[\s\S]*?^END_PROGRAM$/m.exec(DEMO_PROGRAM)?.[0]
  if (shipped === undefined) throw new Error('demoReference: DEMO_PROGRAM has no PROGRAM Palletizer')
  const trucks = shipped.match(/: PalletTruck;/g)?.length ?? 0
  if (trucks !== 2) throw new Error(`demoReference: Palletizer declares ${trucks} PalletTruck instances, not 2`)
  return shipped.replace(/^PROGRAM Palletizer$/m, 'PROGRAM PalletizerLD').replace(/: PalletTruck;/g, ': PalletTruckLD;')
}

/**
 * The shipped program with the twins added after its POUs: PalletizerST, PalletTruckLD and PalletizerLD. The
 * controller's tags stay last, because the engine reads code outside every POU as the controller's only after the POUs.
 * What runs is the controller's choice: {@link ST_REFERENCE_CONTROLLER} or {@link LADDER_REFERENCE_CONTROLLER}.
 */
export const DEMO_REFERENCE_PROGRAM = ((): string => {
  const at = DEMO_PROGRAM.lastIndexOf('END_PROGRAM') + 'END_PROGRAM'.length
  return `${DEMO_PROGRAM.slice(0, at)}\n\n${PALLETIZER_ST}\n\n${PALLET_TRUCK_LD}\n\n${palletizerLd()}${DEMO_PROGRAM.slice(at)}`
})()

/** {@link DEMO_CONTROLLER} running the demo all in Structured Text. */
export const ST_REFERENCE_CONTROLLER: Controller = {
  ...DEMO_CONTROLLER,
  programs: [{ name: 'Main', type: 'PalletizerST', task: 'MainTask' }],
}

/** {@link DEMO_CONTROLLER} running the demo all in ladder. */
export const LADDER_REFERENCE_CONTROLLER: Controller = {
  ...DEMO_CONTROLLER,
  programs: [{ name: 'Main', type: 'PalletizerLD', task: 'MainTask' }],
}
