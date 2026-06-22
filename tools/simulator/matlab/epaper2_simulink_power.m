function epaper2_simulink_power()
% Generate and run a fixed-step Simulink power plant for the browser twin.

inputFile = getenv("EPAPER2_POWER_INPUT");
outputFile = getenv("EPAPER2_POWER_OUTPUT");
if strlength(inputFile) == 0 || strlength(outputFile) == 0
    error("EPAPER2_POWER_INPUT/OUTPUT must be set");
end

p = jsondecode(fileread(inputFile));
tMs = double(p.tMs(:));
loadMa = double(p.loadMa(:));
if numel(tMs) < 2
    error("Need at least two load samples");
end

stepMs = median(diff(tMs));
stepS = stepMs / 1000.0;
tSec = tMs / 1000.0;

params = struct();
params.batteryMv = double(p.batteryMv);
params.capInitialMv = double(p.capInitialMv);
params.rBattMohm = max(1.0, double(p.batteryInternalMohm) + double(p.switchResistanceMohm));
params.rCapMohm = max(1.0, double(p.supercapEsrMohm) + double(p.switchResistanceMohm));
params.capF = max(1e-6, double(p.capacitanceF));
params.chargeOhms = max(0.001, double(p.chargeOhms));
params.leakMa = double(p.supercapLeakageUa) / 1000.0;
params.diodeMv = double(p.diodeDropMv);
params.ldoDropoutMv = double(p.ldoDropoutMv);
params.continuousLimitMa = double(p.continuousLimitMa);
params.pulseLimitMa = double(p.pulseLimitMa);
params.pulseThresholdMa = double(p.pulseThresholdMa);

model = sprintf("epaper2_power_%08x", randi(2^31 - 1));
cleanup = onCleanup(@() localCleanup(model));

assignin("base", "epaper2_loadTs", timeseries(loadMa, tSec));
assignin("base", "epaper2_stepS", stepS);
assignin("base", "epaper2_capInitialMv", params.capInitialMv);
names = fieldnames(params);
for idx = 1:numel(names)
    assignin("base", "epaper2_" + names{idx}, params.(names{idx}));
end

new_system(model);
load_system("simulink");
set_param(model, ...
    "Solver", "FixedStepDiscrete", ...
    "FixedStep", "epaper2_stepS", ...
    "StopTime", num2str(tSec(end), "%.9g"), ...
    "ReturnWorkspaceOutputs", "on", ...
    "SignalLogging", "off");

loadBlock = model + "/Load_mA";
capBlock = model + "/Cap_mV";
plantBlock = model + "/Plant";
add_block("simulink/Sources/From Workspace", loadBlock, ...
    "VariableName", "epaper2_loadTs", ...
    "Position", [30 40 150 70]);
add_block("simulink/Discrete/Discrete-Time Integrator", capBlock, ...
    "InitialCondition", "epaper2_capInitialMv", ...
    "SampleTime", "epaper2_stepS", ...
    "Position", [420 150 500 190]);
add_block("simulink/User-Defined Functions/MATLAB Function", plantBlock, ...
    "Position", [230 80 360 260]);

rt = sfroot;
chart = rt.find("-isa", "Stateflow.EMChart", "Path", char(plantBlock));
if isempty(chart)
    pause(0.2);
    chart = rt.find("-isa", "Stateflow.EMChart", "Path", char(plantBlock));
end
chart.Script = localPlantScript();

add_line(model, "Load_mA/1", "Plant/1", "autorouting", "on");
add_line(model, "Cap_mV/1", "Plant/2", "autorouting", "on");

constantNames = [
    "batteryMv"
    "rBattMohm"
    "rCapMohm"
    "continuousLimitMa"
    "pulseLimitMa"
    "pulseThresholdMa"
    "chargeOhms"
    "leakMa"
    "diodeMv"
    "ldoDropoutMv"
    "capF"
];
for idx = 1:numel(constantNames)
    blockName = "C_" + constantNames(idx);
    constBlock = model + "/" + blockName;
    y = 20 + idx * 32;
    add_block("simulink/Sources/Constant", constBlock, ...
        "Value", "epaper2_" + constantNames(idx), ...
        "Position", [30 y + 80 150 y + 105]);
    add_line(model, blockName + "/1", "Plant/" + string(idx + 2), "autorouting", "on");
end

add_line(model, "Plant/6", "Cap_mV/1", "autorouting", "on");
localAddToWorkspace(model, "VLTE", "Plant/1", "epaper2_vlteOut", 540, 60);
localAddToWorkspace(model, "VBAT_Loaded", "Plant/2", "epaper2_vbatOut", 540, 100);
localAddToWorkspace(model, "V3V3", "Plant/3", "epaper2_v3v3Out", 540, 140);
localAddToWorkspace(model, "IBatt", "Plant/4", "epaper2_ibattOut", 540, 180);
localAddToWorkspace(model, "ICap", "Plant/5", "epaper2_icapOut", 540, 220);
localAddToWorkspace(model, "CapOut", "Cap_mV/1", "epaper2_capOut", 540, 260);

set_param(model, "SimulationCommand", "update");
simOut = sim(model);

vlteOut = simOut.get("epaper2_vlteOut");
vbatOut = simOut.get("epaper2_vbatOut");
v3v3Out = simOut.get("epaper2_v3v3Out");
ibattOut = simOut.get("epaper2_ibattOut");
icapOut = simOut.get("epaper2_icapOut");
capOut = simOut.get("epaper2_capOut");

out = struct();
out.ok = true;
out.engine = "Simulink fixed-step plant";
out.model = model;
out.stepMs = stepMs;
out.samples = numel(vlteOut.time);
out.trace = struct( ...
    "tMs", vlteOut.time(:) * 1000.0, ...
    "loadCurrentMa", interp1(tMs, loadMa, vlteOut.time(:) * 1000.0, "linear", "extrap"), ...
    "batteryLoadedMv", vbatOut.signals.values(:), ...
    "vlteMv", vlteOut.signals.values(:), ...
    "v3v3Mv", v3v3Out.signals.values(:), ...
    "supercapMv", capOut.signals.values(:), ...
    "batteryCurrentMa", ibattOut.signals.values(:), ...
    "supercapCurrentMa", icapOut.signals.values(:) ...
);

fid = fopen(outputFile, "w");
fprintf(fid, "%s", jsonencode(out));
fclose(fid);
end

function script = localPlantScript()
script = [
"function [railMv, vbatLoadedMv, v3v3Mv, ibattMa, icapMa, dCapMvPerS] = Plant(loadMa, capMv, batteryMv, rBattMohm, rCapMohm, continuousLimitMa, pulseLimitMa, pulseThresholdMa, chargeOhms, leakMa, diodeMv, ldoDropoutMv, capF)" newline ...
"loadMa = max(0, loadMa);" newline ...
"limitMa = continuousLimitMa;" newline ...
"if loadMa > pulseThresholdMa" newline ...
"    limitMa = pulseLimitMa;" newline ...
"end" newline ...
"capSourceMv = max(0, capMv - diodeMv);" newline ...
"lo = 0.0;" newline ...
"hi = max(batteryMv, capSourceMv);" newline ...
"for iter = 1:36" newline ...
"    mid = (lo + hi) / 2.0;" newline ...
"    ib = min(limitMa, max(0, (batteryMv - mid) * 1000.0 / rBattMohm));" newline ...
"    ic = max(0, (capSourceMv - mid) * 1000.0 / rCapMohm);" newline ...
"    if ib + ic >= loadMa" newline ...
"        lo = mid;" newline ...
"    else" newline ...
"        hi = mid;" newline ...
"    end" newline ...
"end" newline ...
"railMv = lo;" newline ...
"ib = min(limitMa, max(0, (batteryMv - railMv) * 1000.0 / rBattMohm));" newline ...
"ic = min(max(0, loadMa - ib), max(0, (capSourceMv - railMv) * 1000.0 / rCapMohm));" newline ...
"chargeMa = max(0, (batteryMv - capMv) * 1000.0 / chargeOhms);" newline ...
"ibattMa = ib + chargeMa;" newline ...
"icapMa = ic;" newline ...
"dCapMvPerS = ((chargeMa - ic - leakMa) / 1000.0 / capF) * 1000.0;" newline ...
"vbatLoadedMv = max(0, batteryMv - (ibattMa * rBattMohm) / 1000.0);" newline ...
"v3v3Mv = min(3300, max(0, vbatLoadedMv - ldoDropoutMv));" newline ...
"end" newline ...
];
script = join(script, "");
script = char(script);
end

function localAddToWorkspace(model, name, source, variableName, x, y)
block = model + "/" + name;
add_block("simulink/Sinks/To Workspace", block, ...
    "VariableName", variableName, ...
    "SaveFormat", "Structure With Time", ...
    "Position", [x y x + 110 y + 24]);
add_line(model, source, name + "/1", "autorouting", "on");
end

function localCleanup(model)
try
    if bdIsLoaded(model)
        bdclose(model);
    end
catch
end
end
