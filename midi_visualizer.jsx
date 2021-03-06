﻿var USE_MIDI_SETTINGS_FILE = true;

/*
> author: Sammy Kraus (PeaQew) <peaqew@gmail.com>
> first created: 2021-01-13
> version: 1.0.3 (2021-02-06)
> description:
	* This ExtendScript tool creates a piano roll-style MIDI visualizer inside of Adobe After Effects.

	* Initially created for personal use but built around the SciptUI module to make it more user-friendly and somewhat customizable.

	* This script includes the OMINO MIDI FILE READER by David Van Brink, with light modifications (see below).

/* (Original comments)

Date: Sun Dec 25 22:58:10 PST 2011
Author: David Van Brink
This script is part of the omino adobe script suite.
The latest version can be found at http://omino.com/pixelblog/.

I write these because I like to. Please enjoy as you see fit.

Questions to poly@omino.com, subject line should start with
"plugins" so my spam filter lets it in.

This file has been preprocessed to be
standalone.  I develop them against some
reusable libraries -- such as for dialog
layout -- but for distribution it's nicer to
have just one file. dvb 2007.

The MIDI file reader was modified by PeaQew on Thu Nov 19 2020
to track tempo changes in the midi file.
*/


/*
Description: This After Effects script reads a Standard MIDI file (.mid) and creates layers and keyframes corresponding to the notes and controllers in that MIDI file.
::
*/

//#include "midi_reader.jsx"
// -----------------------------------------
// #include "../shared/ominoMidiFileReader.jsx"
// -----------------------------------------

/*
	The OMINO MIDI FILE READER
	
	This ExtendScript library reads a Standard MIDI File (.mid) into memory, organizing the events
	in a friendly manner suitable for a variety of purposes.
	
	This version only captures note events. Controller info is all lost.
	
	To use it, you create it with a file path, and read info out of the various notes array. Here:
	
	var m = new MidiFile("/path/to/midifile.mid");
	
	var notes = m.notes; // array of NOTE events
	var note = notes[0]; // first note
	var pitch = note.pitch;
	var vel = note.vel; // if zero, it's the END of a note
	var dur = note.duration; // only for note-starts.
	var ch = note.channel; // 16 * trackIndex + midiChannel. note.channel % 16 for midiChannel.

also

	var tracks = m.tracks; // array with per-track goodies
	var channels = m.channels; // array with per-channel goodies.
	
	Future enhancements:
	   • Write a MIDI file
	   • Properly track tempo changes (implemented by PeaQew)
	   • Keep controller & pitch bend changes
	*/

/*
	This constructor takes a path to a MIDI file and, does a very light analysis of it.
	It does just enough to build up an array of note events, which includes the note on
	and note off as separate entries, in an array called notes.
	
	note.time is the time in seconds
	note.pitch
	note.vel is 0 for note off.
	*/
function MidiFile(filePath) {
    addMidiFileMethods(this);

    this.microsecondsPerQuarterNote = 500000;
    this.timeSignatureNumerator = 4;
    this.timeSignatureDenominator = 4;
    this.timeSignatureMetronomeInterval = 24;
    this.timeSignatureHemiDemiSemiNotesPerQuarterNote = 8;

    this.filePath = filePath;
    this.file = readFile(filePath);
    this.fileLength = this.file.length;
    this.isMidi = isMidi(this.file);

    this.format = this.getShort(8);
    this.trackCount = this.getShort(10);
    this.timeDivision = this.getShort(12);
    if (this.timeDivision & 0x8000)
        this.framesPerSecond = this.timeDivision & 0x7fff;
    else
        this.ticksPerBeat = this.timeDivision; // more common.

    if (midiWndw.halfSpeedCheckbox.value == true) // TODO: Find the reason for why some MIDI files appear to be at double speed
        this.timeDivision /= 2;

    this.chunkCount = 0;
    this.noteOns = 0;
    this.noteOffs = 0;

    this.notes = new Array();
    this.channels = new Array();
    this.tracks = new Array();

    this.tempoMap = new Array();
    this.timeSignatureMap = new Array();

    if (midiWndw.pb.isCanceled)
        return;

    // read the rest of the chunks.
    var offset = 14;
    currentTrack = 0;
    while (offset < this.fileLength) {
        var chunkType = this.file.substring(offset, offset + 4);
        var chunkLength = this.getLong(offset + 4);
        this.chunkCount++;

        if (chunkType == "MTrk") {
            var track = new Track();
            this.tracks.push(track);
            var previousStatus = 0;
            var chunkOffset = offset + 8;
            var chunkEnd = chunkOffset + chunkLength;
            var ticks = 0;
            var midiChannelPrefix = 0;
            var seconds = 0;
            while (chunkOffset < chunkEnd) {
                var partial = this.file.substring(chunkOffset, chunkEnd);
                var delta = this.getVarVal(chunkOffset);
                ticks += delta;

                var beats = 0;
                if (ticks && this.timeDivision && this.microsecondsPerQuarterNote) {
                    var deltaSeconds = this.getTime(ticks);
                    seconds = deltaSeconds;
                    beats = ticks / this.timeDivision;
                }
                chunkOffset += this.getVarLen(chunkOffset);
                var status = this.file.charCodeAt(chunkOffset);
                if (status & 0x80)
                    chunkOffset++;
                else
                    status = previousStatus;

                var statusTop = (status & 0xf0) >> 4;
                var channel = (currentTrack) * 16 + (status & 0x0f);
                var b1 = this.file.charCodeAt(chunkOffset);
                var b2 = this.file.charCodeAt(chunkOffset + 1);

                if (status == 0xff)
                    statusTop = status;
                switch (statusTop) {
                    case 8: // note off
                        this.addNote(seconds, beats, channel, b1, 0);
                        break;
                    case 9: // note on (or note off if b2==0)
                        this.addNote(seconds, beats, channel, b1, b2);
                        break;
                    case 0xff:
                        {
                            switch (b1) {
                                case 0x03: // track name
                                    trackName = this.getVarString(chunkOffset + 1);
                                    track.name = trackName;
                                    break;
                                case 0x04: // instrument name
                                    channel = (currentTrack) * 16 + midiChannelPrefix;
                                    var channelO = this.findChannel(channel);
                                    channelO.instrument = this.getVarString(chunkOffset + 1);
                                    break;
                                case 0x20: // midi channel prefix
                                    midiChannelPrefix = this.getByte(chunkOffset + 2);
                                    break;
                                case 0x51: // tempo
                                    this.microsecondsPerQuarterNote = this.getInt24(chunkOffset + 2);
                                    this.addTempo(ticks, this.microsecondsPerQuarterNote);
                                    break;
                                case 0x54: // smpte offset
                                    break;
                                case 0x58: // sig
                                    this.timeSignatureNumerator = this.getByte(chunkOffset + 2);
                                    this.timeSignatureDenominator = 1 << this.getByte(chunkOffset + 3);
                                    this.timeSignatureMetronomeInterval = this.getByte(chunkOffset + 4);
                                    this.timeSignatureHemiDemiSemiNotesPerQuarterNote = this.getByte(chunkOffset + 5);
                                    this.addTimeSignatureAt(ticks, this.timeSignatureNumerator, this.timeSignatureDenominator, this.timeSignatureMetronomeInterval, this.timeSignatureHemiDemiSemiNotesPerQuarterNote);
                                    break;
                            }
                        }
                        break;
                }

                var eventLength = this.getEventLength(status, chunkOffset);
                chunkOffset += eventLength;
                previousStatus = status;
            }
            currentTrack++;
        }

        offset += 8 + chunkLength;
    }
    // sort the event-bucket
    this.notes.sort(function(a, b) {
        return a.time - b.time;
    });
}

function readFile(filePath) {
    var f = new File(filePath);
    f.encoding = "BINARY";

    f.open("r");
    var length = f.length;
    var result = f.read(length);
    f.close();
    return result;
}

function isMidi(s) {
    var h = s.substring(0, 4);
    var result = h == "MThd";
    return result;
}

// time in seconds
function Note(time, beats, channel, pitch, vel) {
    this.time = time;
    this.beats = beats;
    this.channel = channel;
    this.pitch = pitch;
    this.vel = vel;
}

function Channel(index) {
    this.index = index;
    this.trackIndex = Math.floor(index / 16);
    this.midiChannel = index % 16;
    this.notes = new Array();
}

function Track(index) {
    this.index = index;
    this.channels = new Array();
}

// Represents a tempo at a given point in time. Should be used in an array to create a tempo map
function Tempo(tick, microsecondsPerQuarterNote) {
    this.tick = tick;
    this.microsecondsPerQuarterNote = microsecondsPerQuarterNote;
}

// Represents a time signature at a given point in time. Should be used in an array to create a time signature map
function TimeSignature(tick, numerator, denominator, metronomeInterval, hemiDemiSemiNotesPerQuarterNote) {
    this.tick = tick;
    this.numerator = numerator;
    this.denominator = denominator;
    this.metronomeInterval = metronomeInterval;
    this.hemiDemiSemiNotesPerQuarterNote = hemiDemiSemiNotesPerQuarterNote;
    this.second = 0; // Will be calculated later
}

// Represents a BPM change at a given point. Should be used in an array to create a tempo map
function BPM(second, bpm, microsecondsPerQuarterNote) {
    this.second = second;
    this.bpm = bpm;
    this.microsecondsPerQuarterNote = microsecondsPerQuarterNote;
}

function addMidiFileMethods(m) {
    m.getShort = function(offset) {
        var result = this.file.charCodeAt(offset) * 256 +
            this.file.charCodeAt(offset + 1);
        return result;
    }

    m.getLong = function(offset) {
        var result = this.file.charCodeAt(offset) * (1 << 24) +
            this.file.charCodeAt(offset + 1) * (1 << 16) +
            this.file.charCodeAt(offset + 2) * (1 << 8) +
            this.file.charCodeAt(offset + 3);
        return result;
    }

    m.getByte = function(offset) {
        var result = this.file.charCodeAt(offset);
        return result;
    }

    m.getInt24 = function(offset) {
        var result = this.file.charCodeAt(offset) * (1 << 16) +
            this.file.charCodeAt(offset + 1) * (1 << 8) +
            this.file.charCodeAt(offset + 2) * (1 << 0);
        return result;
    }

    /*
    Find a channel reference, or create it if needed, to assign.
    index is trackIndex * 16 + channel
    */
    m.findChannel = function(index) {
        var channel = this.channels[index];
        if (!channel) {
            channel = new Channel(index);
            this.channels[index] = channel;
            var track = this.tracks[Math.floor(index / 16)]; // it MUST already be allocated.
            var midiChannel = index % 16;
            track.channels.push(channel);
        }
        return channel;
    }

    m.addNote = function(time, beats, channel, pitch, vel) {
        var note = new Note(time, beats, channel, pitch, vel);
        this.notes.push(note);

        var channelO = this.findChannel(channel);
        channelO.notes.push(note);

        if (vel) {
            this.noteOns++;
        } else {
            this.noteOffs++;
            // note-off? try to assign duration to a note-on
            for (var i = channelO.notes.length - 2; i >= 0; i--) {
                var note2 = channelO.notes[i];
                if (note2.vel && note2.pitch == pitch) {
                    note2.durTime = time - note2.time;
                    note2.durBeats = beats - note2.beats;
                    i = 0;
                    //					break;
                }
            }
        }

        return note;
    }

    m.addTimeSignatureAt = function(tick, numerator, denominator, metronomeInterval, hemiDemiSemiNotesPerQuarterNote) {
        this.timeSignatureMap.push(new TimeSignature(tick, numerator, denominator, metronomeInterval, hemiDemiSemiNotesPerQuarterNote))
    }

    m.getEventLength = function(status, offset) {
        var statusTop = (status & 0xf0) >> 4;
        switch (statusTop) {
            case 0x8:
            case 0x9:
            case 0xa:
            case 0xb:
            case 0xe:
                return 2;
            case 0xc:
            case 0xd:
                return 1;
        }

        if (status == 0xff || status == 0xf0) // meta or sysex
        {
            var result = this.getVarVal(offset + 1);
            result += this.getVarLen(offset + 1);
            result += 1;
            return result;

            // meta events
            //~ 				case 0: // sequence number short
            //~ 				case 1: // text event
            //~ 				case 2: // copyright
            //~ 				case 3: // seq/trk name
            //~ 				case 4: // instrument name
            //~ 				case 5: // lyrics
            //~ 				case 6: // marker
            //~ 				case 7: // cue point
            //~ 				case 0x20: // midi channel for next instrument name
            //~ 				case 0x2f: // end of track
            //~ 				case 0x51: // tempo
            //~ 				case 0x54: // smpte offset
            //~ 				case 0x58: // time signature
            //~ 				case 0x59: // key signature
            //~ 				case 0x7f: // sequencer-specific
        }


    }

    m.getVarLen = function(offset) {
        var result = 1;
        while (1) {
            if (this.file.charCodeAt(offset) & 0x80) {
                result++;
                offset++;
            } else
                return result;
        }
    }

    m.getVarVal = function(offset) {
        var result = 0;
        while (1) {
            var b = this.file.charCodeAt(offset);
            result = result * 128 + (b & 0x7f);
            if (b & 0x80)
                offset++;
            else
                return result;
        }
    }

    m.getVarString = function(offset) {
        var result = "";
        var len = this.getVarVal(offset);
        var lenlen = this.getVarLen(offset);
        result = this.file.substring(offset + lenlen, offset + lenlen + len);
        return result;
    }

    // Add tempo change to the tempo map
    m.addTempo = function(tick, microsecondsPerQuarterNote) {
        var tempo = new Tempo(tick, microsecondsPerQuarterNote);
        this.tempoMap.push(tempo);
    }

    // Get the current active tempo at the specified tick
    m.getTempo = function(tick) {
        var result = 500000;
        var tempo;
        for (var i = 0; i < this.tempoMap.length; i++) {
            tempo = this.tempoMap[i];
            result = tempo.microsecondsPerQuarterNote;
            if (tick > tempo.tick) {
                if (i + 1 < this.tempoMap.length) {
                    if (tick <= this.tempoMap[i + 1].tick) {
                        break;
                    }
                }
            }
        }
        return result;
    }

    // Get time in seconds, while keeping tempo changes in mind
    m.getTime = function(targetTick) {
        var seconds = 0;

        var currentMicrosecondsPerQuarterNote = 500000;

        var tickCounter = 0;
        var prevTickCounter = 0;
        var deltaTickCounter = 0;

        var index = 0;
        var tempo;
        while (tickCounter < targetTick) {
            if (index < this.tempoMap.length) {
                tempo = this.tempoMap[index];
                currentMicrosecondsPerQuarterNote = tempo.microsecondsPerQuarterNote;
                if (index + 1 >= this.tempoMap.length) { // Are there any tempo changes left?
                    tickCounter = targetTick;
                } else if (targetTick <= this.tempoMap[index + 1].tick) { // Is there a tempo change before the target tick?
                    tickCounter = targetTick;
                } else {
                    tickCounter = this.tempoMap[index + 1].tick;
                }
                index++;
            } else {
                tickCounter = targetTick;
            }
            deltaTickCounter = tickCounter - prevTickCounter;
            seconds += (currentMicrosecondsPerQuarterNote * deltaTickCounter) / this.timeDivision / 1000000;
            prevTickCounter = tickCounter;
        }
        return seconds;
    }
}
// ...
// OMINO MIDI FILE READER end //

function ProgressBar(parentPanel) {
    var pbObj = new Object();
    pbObj.container = parentPanel.add("group");;

    pbObj.isCanceled = false;

    pbObj.container.alignment = ["left", "bottom"];
    pbObj.container.orientation = "column";
    pbObj.container.alignChildren = "left";

    pbObj.progressGroup = pbObj.container.add("group");
    pbObj.progressGroup.orientation = "column";
    pbObj.progressGroup.alignChildren = "left";
    pbObj.progressGroup.visible = false;

    pbObj.totalProgressText = pbObj.progressGroup.add("statictext", [0, 0, 512, 16]);
    pbObj.totalProgressBar = pbObj.progressGroup.add("progressbar");

    pbObj.currentProgressText = pbObj.progressGroup.add("statictext", [0, 0, 512, 16]);
    pbObj.currentProgressBar = pbObj.progressGroup.add("progressbar");

    pbObj.createCancelBtn = pbObj.container.add("button", undefined, "Create");
    pbObj.createCancelBtn.onClick = createVisualizer;

    pbObj.start = function() {
        pbObj.createCancelBtn.text = "Cancel";
        pbObj.createCancelBtn.onClick = function() {
            pbObj.isCanceled = true;
        }
        pbObj.isCanceled = false;
        pbObj.progressGroup.visible = true;
        pbObj.startTime = Date.now();
    }
    pbObj.stop = function() {
        pbObj.createCancelBtn.text = "Create";
        pbObj.createCancelBtn.onClick = createVisualizer;
        pbObj.endTime = Date.now();
        var deltaTime = pbObj.endTime - pbObj.startTime;
        deltaTime /= 1000;
        pbObj.deltaTime = Math.round(deltaTime);
    }

    pbObj.updateTotal = function(text, progressValue) {
        this.totalProgressText.text = text;
        this.totalProgressBar.value = progressValue;
        midiWndw.update();
    }
    pbObj.updateCurrent = function(text, progressValue) {
        this.currentProgressText.text = text;
        this.currentProgressBar.value = progressValue;
        midiWndw.update();
    }
    pbObj.totalProgressBar.preferredSize.width = 256;
    pbObj.currentProgressBar.preferredSize.width = 256;

    return pbObj;
}

function showSettingsWindow() {
    var settingsWndw = new Window("dialog", "Visualizer Settings");
    settingsWndw.orientation = "column";
    settingsWndw.add("statictext", undefined, "Hover over the label to see additional information.");

    var tabbedPanel = settingsWndw.add("tabbedpanel");
    tabbedPanel.preferredSize = [512, 512];

    var tabGeneral = tabbedPanel.add("tab", undefined, "General");

    var tabNotes = tabbedPanel.add("tab", undefined, "Notes");
    tabNotes.orientation = "row";

    tabNotes.left = tabNotes.add("group");
    tabNotes.left.orientation = "column";
    tabNotes.left.alignment = "top";
    tabNotes.left.alignChildren = "top";

    tabNotes.right = tabNotes.add("group");
    tabNotes.right.orientation = "column";
    tabNotes.right.alignment = "top";
    tabNotes.right.alignChildren = "top";

    var tabBarLines = tabbedPanel.add("tab", undefined, "Bar Lines");
    var tabPianoKeys = tabbedPanel.add("tab", undefined, "Piano Keys");
    var tabAdvanced = tabbedPanel.add("tab", undefined, "Advanced");
    var tabContact = tabbedPanel.add("tab", undefined, "Contact");
    tabContact.add("panel").add("statictext", [0 + 16, 0 + 16, 384 + 16, 512 + 16], "Need a new feature? Found a bug? Here's how you can contact me:\n\nE-Mail: peaqew@gmail.com\nDiscord: PeaQ#9827\nReddit: u/PeaQew\nTwitter: @PeaQew", {
        multiline: true
    }).alignment = "left";

    function addCategoryToTab(tab, name) {
        category = tab.add("panel", undefined, name);
        category.alignment = "left";
        category.orientation = "row";

        category.labels = category.add("group", undefined, "labels");
        category.labels.orientation = "column";
        category.labels.alignChildren = "right";
        category.labels.spacing = 8;

        category.controls = category.add("group", undefined, "controls");
        category.controls.preferredSize.width = 128;
        category.controls.orientation = "column";
        category.controls.alignChildren = "left";
        category.controls.spacing = 8;

        return category;
    }

    var catGeneralComp = addCategoryToTab(tabGeneral, "Composition");
    var catGeneralbpmText = addCategoryToTab(tabGeneral, "BPM Text");

    var catNotePosSize = addCategoryToTab(tabNotes.left, "Position");
    var catNoteFxAnim = addCategoryToTab(tabNotes.right, "FX & Animation");

    var catbarLinesPos = addCategoryToTab(tabBarLines, "Position");
    var catbarLinesFont = addCategoryToTab(tabBarLines, "Font");

    var catPianoKeysSettings = addCategoryToTab(tabPianoKeys, "Settings");
    var catPianoKeysFont = addCategoryToTab(tabPianoKeys, "Font");

    var catAdvSettings = addCategoryToTab(tabAdvanced, "Settings");
    var catAdvExtra = addCategoryToTab(tabAdvanced, "Extra");

    catAdvExtra.labels.add("button", undefined, "Revert to Factory Default").onClick = function() {
        if (Window.confirm("Do you wish to revert your settings back to the factory default? This will not actually touch the settings file.")) {
            midiCustomSettings.revertToDefaultValues();
            settingsWndw.close();
        }
    }

    function createLabel(container, text, tooltip) {
        var label = container.add("statictext", undefined, text);
        label.preferredSize.height = 24;
        label.helpTip = tooltip;
        return label;
    }

    createLabel(catGeneralComp.labels, "Scoller Framerate",
        "Framerate of the scrolling compositions.");
    createLabel(catGeneralComp.labels, "Note Framerate",
        "Framerate of the compositions containing the notes. Only really affects animations and effects that run on the notes (shape layers) themselves.");
    createLabel(catGeneralComp.labels, "Comp Width",
        "The width of all compositions.");
    createLabel(catGeneralComp.labels, "Comp Height",
        "The height of all compositions.");

    createLabel(catGeneralbpmText.labels, "Create BPM Text",
        "Creates a text layer that shows the current BPM of the song.");
    createLabel(catGeneralbpmText.labels, "Font",
        "The font of the BPM Text.");
    createLabel(catGeneralbpmText.labels, "Font Size",
        "The pixel size of the font.");

    createLabel(catNotePosSize.labels, "Note X Offset",
        "Pixel offset in the X axis for the note activation, starting from the left.");
    createLabel(catNotePosSize.labels, "Note Y Offset",
        "Pixel offset in the Y axis for the notes, starting from the bottom.");
    createLabel(catNotePosSize.labels, "Pitch Bottom Threshold",
        "Sets the floor for the lowest MIDI note pitch. 21 is A0.");
    createLabel(catNotePosSize.labels, "Pitch Top Threshold",
        "Sets the ceiling for the highest MIDI note pitch. 127 is G9, 108 is C8.");

    createLabel(catNotePosSize.labels, "White Note Size",
        "Size of white notes (non-sharpened).");
    createLabel(catNotePosSize.labels, "Black Note Size",
        "Size of black notes (sharpened).");

    createLabel(catNoteFxAnim.labels, "Note Velocity",
        "Speed of notes in pixels per second.");
    createLabel(catNoteFxAnim.labels, "BPM Based Speed",
        "BPM affects note scrolling speed. A multiplier is calculated based on 120BPM.\n\nEx: 180BPM would be a 1.5x multiplier.");
    createLabel(catNoteFxAnim.labels, "Fade Out Duration",
        "Threshold for the duration a note needs to have to set the opacity to 0% over its duration.\nEx: If set to 2 seconds, a note with a duration of 1 second will animate its opacity to 50% over its duration until \'Fade Out Time\' gets activated.");
    createLabel(catNoteFxAnim.labels, "Fade Out Time",
        "The time it takes for the note to fade out once it finished playing.");
    createLabel(catNoteFxAnim.labels, "Darken Black Notes",
        "Sets a darkening tint on the sharpened notes.");
    createLabel(catNoteFxAnim.labels, "Darken Amount",
        "The amount of darkening applied to sharpened notes.");
    createLabel(catNoteFxAnim.labels, "DropShadow Blur Size",
        "The amount of blur added to the DropShadow effect of notes. Set to 0 to disable.");

    createLabel(catbarLinesPos.labels, "Y Position",
        "The Y position at which all lines start.");
    createLabel(catbarLinesPos.labels, "Bar Length",
        "The length of the line of the first beat of a bar.");
    createLabel(catbarLinesPos.labels, "Beat Length",
        "The length of beats between the bars.");
    createLabel(catbarLinesFont.labels, "Font",
        "The PostScript name of the font.");
    createLabel(catbarLinesFont.labels, "Font Size",
        "The pixel size of the font.");

    createLabel(catPianoKeysSettings.labels, "Create Indicator",
        "Creates a line at the position where notes start.");
    createLabel(catPianoKeysSettings.labels, "Create Keys",
        "Creates lines that represent the piano keys. Text layers are created at C keys");
    createLabel(catPianoKeysSettings.labels, "Indicator Width",
        "The width of the indicator");
    createLabel(catPianoKeysSettings.labels, "Key Gap Size",
        "The gap between the keys and the indicator.");
    createLabel(catPianoKeysSettings.labels, "White Key Width",
        "The width of the white keys.");
    createLabel(catPianoKeysSettings.labels, "Black Key Width",
        "The width of the black keys");
    createLabel(catPianoKeysFont.labels, "Font",
        "The PostScript name of the font.");
    createLabel(catPianoKeysFont.labels, "Font Size",
        "The pixel size of the font.");

    createLabel(catAdvSettings.labels, "BPM Source Index",
        "The index of the MIDI file to take the tempo map from.\nIf the index is out of range, 0 or the last index will be used instead.\n\nNote: 0 Is the first MIDI file.");
    createLabel(catAdvSettings.labels, "Time Signature Source Index",
        "The index of the MIDI file to take the time signature from.\nIf the index is out of range, 0 or the last index will be used instead.\n\nNote: 0 Is the first MIDI file.");
    createLabel(catAdvSettings.labels, "Trailing Duration",
        "Additional amount of time to scroll after the last note (for each MIDI) stopped playing.");
    createLabel(catAdvSettings.labels, "BPM Change Threshold",
        "The difference in BPM for a change to be registered.\n\nEx: A threshold of 1 means that a keyframe (for scrolling etc.) will be added every time the BPM changes by 1.\nNote that if you set this number too low, After Effects may not be able to handle this.");

    catGeneralComp.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.scrollCompFramerate)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.scrollCompFramerate;
            else {
                midiCustomSettings.scrollCompFramerate = parseInt(this.text, 10);
            }
        };
    catGeneralComp.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.noteCompFramerate)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.noteCompFramerate;
            else {
                midiCustomSettings.noteCompFramerate = parseInt(this.text, 10);
            }
        };
    catGeneralComp.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.resolutionWidth)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.resolutionWidth;
            else {
                midiCustomSettings.resolutionWidth = parseInt(this.text, 10);
            }
        };
    catGeneralComp.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.resolutionHeight)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.resolutionHeight;
            else {
                midiCustomSettings.resolutionHeight = parseInt(this.text, 10);
            }
        };
    var checkBox = catGeneralbpmText.controls.add("CheckBox", [0, 0, 64, 24], midiCustomSettings.createBpmText)
    checkBox.value = midiCustomSettings.createBpmText;
    checkBox.text = midiCustomSettings.createBpmText == true ? "On" : "Off";
    checkBox.onClick = function() {
        midiCustomSettings.createBpmText = this.value;
        this.text = midiCustomSettings.createBpmText == true ? "On" : "Off";
    };
    catGeneralbpmText.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.bpmTextFont)
        .onChanging = function() {
            midiCustomSettings.bpmTextFont = this.text;
        };
    catGeneralbpmText.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.bpmTextFontSize)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.bpmTextFontSize;
            else {
                midiCustomSettings.bpmTextFontSize = parseInt(this.text, 10);
            }
        };
    catNotePosSize.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.noteHitXOffset)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.noteHitXOffset;
            else {
                midiCustomSettings.noteHitXOffset = parseInt(this.text, 10);
            }
        };
    catNotePosSize.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.noteYOffset)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.noteYOffset;
            else {
                midiCustomSettings.noteYOffset = parseInt(this.text, 10);
            }
        };
    catNotePosSize.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pitchBottomThreshold)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.pitchBottomThreshold;
            else {
                midiCustomSettings.pitchBottomThreshold = parseInt(this.text, 10);
            }
        };
    catNotePosSize.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pitchTopThreshold)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.pitchTopThreshold;
            else {
                midiCustomSettings.pitchTopThreshold = parseInt(this.text, 10);
            }
        };
    catNotePosSize.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.whiteNoteSize)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.whiteNoteSize;
            else {
                midiCustomSettings.whiteNoteSize = parseInt(this.text, 10);
            }
        };
    catNotePosSize.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.blackNoteSize)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.blackNoteSize;
            else {
                midiCustomSettings.blackNoteSize = parseInt(this.text, 10);
            }
        };
    catNoteFxAnim.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.velocityPerSecond)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.velocityPerSecond;
            else {
                midiCustomSettings.velocityPerSecond = parseInt(this.text, 10);
            }
        };
    var checkBox = catNoteFxAnim.controls.add("CheckBox", [0, 0, 64, 24], midiCustomSettings.bpmBasedSpeed)
    checkBox.value = midiCustomSettings.bpmBasedSpeed;
    checkBox.text = midiCustomSettings.bpmBasedSpeed == true ? "On" : "Off";
    checkBox.onClick = function() {
        midiCustomSettings.bpmBasedSpeed = this.value;
        this.text = midiCustomSettings.bpmBasedSpeed == true ? "On" : "Off";
    };
    catNoteFxAnim.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.fadeOutDuration)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.fadeOutDuration;
            else {
                midiCustomSettings.fadeOutDuration = parseFloat(this.text);
            }
        };
    catNoteFxAnim.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.fadeOutTime)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.fadeOutTime;
            else {
                midiCustomSettings.fadeOutTime = parseFloat(this.text);
            }
        };
    var checkBox = catNoteFxAnim.controls.add("CheckBox", [0, 0, 64, 24], midiCustomSettings.darkenBlackNotes)
    checkBox.value = midiCustomSettings.darkenBlackNotes;
    checkBox.text = midiCustomSettings.darkenBlackNotes == true ? "On" : "Off";
    checkBox.onClick = function() {
        midiCustomSettings.darkenBlackNotes = this.value;
        this.text = midiCustomSettings.darkenBlackNotes == true ? "On" : "Off";
    };
    catNoteFxAnim.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.darkenAmount)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.darkenAmount;
            else {
                midiCustomSettings.darkenAmount = parseInt(this.text, 10);
            }
        };
    catNoteFxAnim.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.dropShadowBlurSize)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.dropShadowBlurSize;
            else {
                midiCustomSettings.dropShadowBlurSize = parseInt(this.text, 10);
            }
        };
    catbarLinesPos.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.barLineYPos)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.barLineYPos;
            else {
                midiCustomSettings.barLineYPos = parseInt(this.text, 10);
            }
        };
    catbarLinesPos.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.barLineBarHeight)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.barLineBarHeight;
            else {
                midiCustomSettings.barLineBarHeight = parseInt(this.text, 10);
            }
        };
    catbarLinesPos.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.barLineBeatHeight)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.barLineBeatHeight;
            else {
                midiCustomSettings.barLineBeatHeight = parseInt(this.text, 10);
            }
        };
    catbarLinesFont.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.barLineFont)
        .onChanging = function() {
            midiCustomSettings.barLineFont = this.text;
        };
    catbarLinesFont.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.barLineFontSize)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.barLineFontSize;
            else {
                midiCustomSettings.barLineFontSize = parseInt(this.text, 10);
            }
        };
    var checkBox = catPianoKeysSettings.controls.add("CheckBox", [0, 0, 64, 24], midiCustomSettings.bpmBasedSpeed)
    checkBox.value = midiCustomSettings.pianoKeysCreateIndicator;
    checkBox.text = midiCustomSettings.pianoKeysCreateIndicator == true ? "On" : "Off";
    checkBox.onClick = function() {
        midiCustomSettings.pianoKeysCreateIndicator = this.value;
        this.text = midiCustomSettings.pianoKeysCreateIndicator == true ? "On" : "Off";
    };
    var checkBox = catPianoKeysSettings.controls.add("CheckBox", [0, 0, 64, 24], midiCustomSettings.bpmBasedSpeed)
    checkBox.value = midiCustomSettings.pianoKeysCreateKeys;
    checkBox.text = midiCustomSettings.pianoKeysCreateKeys == true ? "On" : "Off";
    checkBox.onClick = function() {
        midiCustomSettings.pianoKeysCreateKeys = this.value;
        this.text = midiCustomSettings.pianoKeysCreateKeys == true ? "On" : "Off";
    };

    catPianoKeysSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pianoKeysIndicatorWidth)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.pianoKeysIndicatorWidth;
            else {
                midiCustomSettings.pianoKeysIndicatorWidth = parseInt(this.text, 10);
            }
        };
    catPianoKeysSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pianoKeysGapSize)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.pianoKeysGapSize;
            else {
                midiCustomSettings.pianoKeysGapSize = parseInt(this.text, 10);
            }
        };
    catPianoKeysSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pianoKeysWhiteKeyWidth)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.pianoKeysWhiteKeyWidth;
            else {
                midiCustomSettings.pianoKeysWhiteKeyWidth = parseInt(this.text, 10);
            }
        };
    catPianoKeysSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pianoKeysBlackKeyWidth)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.pianoKeysBlackKeyWidth;
            else {
                midiCustomSettings.pianoKeysBlackKeyWidth = parseInt(this.text, 10);
            }
        };
    catPianoKeysFont.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pianoKeysFont)
        .onChanging = function() {
            midiCustomSettings.pianoKeysFont = this.text;
        };
    catPianoKeysFont.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.pianoKeysFontSize)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.pianoKeysFontSize;
            else {
                midiCustomSettings.pianoKeysFontSize = parseInt(this.text, 10);
            }
        };
    catAdvSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.bpmSourceIndex)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.bpmSourceIndex;
            else {
                midiCustomSettings.bpmSourceIndex = parseInt(this.text, 10);
            }
        };
    catAdvSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.timeSigSourceIndex)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.timeSigSourceIndex;
            else {
                midiCustomSettings.timeSigSourceIndex = parseInt(this.text, 10);
            }
        };
    catAdvSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.trailingDuration)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.trailingDuration;
            else {
                midiCustomSettings.trailingDuration = parseFloat(this.text);
            }
        };
    catAdvSettings.controls.add("edittext", [0, 0, 128, 24], midiCustomSettings.bpmChangeThreshold)
        .onChanging = function() {
            if (isNaN(this.text))
                this.text = midiCustomSettings.bpmChangeThreshold;
            else {
                midiCustomSettings.bpmChangeThreshold = parseFloat(this.text);
            }
        };

    tabGeneral.add("statictext", [0, 0, 320, 256], "Note about fonts: The font's PostScript name is required. If the specified font can't be found, AE will use Myriad Pro instead. To get specific a font weight, include it in the name.", {
        multiline: true
    }).alignment = "left";

    settingsWndw.bottom = settingsWndw.add("group");
    settingsWndw.bottom.orientation = "row";
    settingsWndw.bottom.alignment = "left";

    settingsWndw.bottom.add("button", undefined, "Save as Default").onClick = function() {
        if (midiCustomSettings.saveToXml(xmlSettingsObj)) {
            Window.alert("Settings saved to " + "\'" + (new File($.fileName)).parent.fsName + "/pq_midi_settings.xml\'.");
        }
    }
    settingsWndw.bottom.add("button", undefined, "Revert to Default").onClick = function() {
        if (Window.confirm("Do you wish to revert your settings back to the state of the settings file?")) {
            midiCustomSettings.readFromXml(xmlSettingsObj);
            settingsWndw.close();
        }
    }
    settingsWndw.bottom.add("button", undefined, "Show Project Page").onClick = function() {
        if (Window.confirm("This will open your browser and redirect you to the Github page.\nProceed?")) {
            if (hasWriteAndNetworkAccess()) {
                var userOSVer = getOS();
                if (userOSVer == "MAC") {
                    var urlLaunchCode = "Open"; // Mac
                } else {
                    var urlLaunchCode = "cmd.exe /c Start"; // PC
                }
                system.callSystem(urlLaunchCode + " " + "https://github.com/PeaQew/MidiNoteVisualizerAE");
            }
        }
    }
    settingsWndw.show();
}

function getOS() {
    var match = $.os.indexOf("Windows");
    if (match != (-1)) {
        var userOS = "PC"; // User is on PC
    } else {
        var userOS = "MAC"; // User is on MAC
    }
    return userOS;
}

function readMidiFiles() {
    var parsedFiles = new Array();
    midiWndw.pb.updateTotal("Reading MIDI files... The window may become unresponsive during this step if there is a lot of data.", 5)
    for (var i = 0; i < midiConfigs.length; i++) {
        midiWndw.pb.updateCurrent("Parsing " + midiConfigs[i].name + "... (" + (i + 1) + "/" + midiConfigs.length + ")", ((i + 1) / midiConfigs.length) * 100);
        parsedFiles.push(new MidiFile(midiConfigs[i].filePath));
        if (midiWndw.pb.isCanceled)
            break;
    }
    return parsedFiles;
}

// Gets the time when the last MIDI note ends
function getLatestMidiNote(midiFiles) {
    var latestMidiNote = 0;
    if (midiFiles.constructor == Array) {
        for (var i = 0; i < midiFiles.length; i++) {
            if (midiFiles[i].notes.length == 0)
                continue;

            var noteTime = undefined;
            var noteDur = undefined;

            var noteIndex = midiFiles[i].notes.length - 1;
            while (noteDur == undefined) { // Find the last note with a duration
                noteTime = midiFiles[i].notes[noteIndex].time;
                noteDur = midiFiles[i].notes[noteIndex].durTime;
                noteIndex--;
                if (noteIndex < 0)
                    break;
            }
            if (latestMidiNote < noteTime + noteDur) {
                latestMidiNote = noteTime + noteDur;
            }
        }
    } else {
        var noteIndex = midiFiles.notes.length - 1;
        while (noteDur == undefined) { // Find the last note with a duration
            if (midiFiles.notes.length == 0)
                break;

            var noteTime = midiFiles.notes[noteIndex].time;
            var noteDur = midiFiles.notes[noteIndex].durTime;
            noteIndex--;
            if (noteIndex < 0)
                break;
        }
        if (latestMidiNote < noteTime + noteDur) {
            latestMidiNote = noteTime + noteDur;
        }
    }
    return latestMidiNote + midiCustomSettings.trailingDuration;
}


function getXPositionAndWidthOfNote(startTime, noteDur, bpmMap) {
    var currentPosition = 0;
    var currentWidth = 0;

    if (midiCustomSettings.bpmBasedSpeed) {
        var currentSecond = 0;
        var bpmIndex = 0;
        var tempSeconds = 0;

        while (currentSecond != startTime) { // Calculate X position
            var currentBpm = bpmMap[bpmIndex].bpm;
            if (bpmIndex + 1 < bpmMap.length && bpmMap[bpmIndex + 1].second < startTime) {
                var newSecond = bpmMap[bpmIndex + 1].second;

                var deltaSeconds = newSecond - currentSecond;

                var speedMultiplier = midiCustomSettings.bpmBasedSpeed ? currentBpm / 120.0 : 1;
                var deltaPosition = (deltaSeconds * (midiCustomSettings.velocityPerSecond * speedMultiplier));

                currentPosition += deltaPosition;
                currentSecond = newSecond;
                bpmIndex++;

            } else {
                var newSecond = startTime;
                var deltaSeconds = newSecond - currentSecond;

                var speedMultiplier = midiCustomSettings.bpmBasedSpeed ? currentBpm / 120.0 : 1;
                var deltaPosition = deltaSeconds * (midiCustomSettings.velocityPerSecond * speedMultiplier);

                currentPosition += deltaPosition;
                currentSecond = newSecond;
            }
        }
        var noteEndTime = startTime + noteDur;
        while (currentSecond != noteEndTime) { // Calculate width TEMP: Width is always set using the first BPM value
            var currentBpm = bpmMap[bpmIndex].bpm;
            if (bpmIndex + 1 < bpmMap.length && bpmMap[bpmIndex + 1].second < noteEndTime) {
                var newSecond = bpmMap[bpmIndex + 1].second;

                var deltaSeconds = newSecond - currentSecond;

                var speedMultiplier = midiCustomSettings.bpmBasedSpeed ? currentBpm / 120.0 : 1;
                var deltaSize = deltaSeconds * (midiCustomSettings.velocityPerSecond * speedMultiplier);

                currentWidth += deltaSize;
                currentSecond = newSecond;
                bpmIndex++;
            } else {
                // var currentBpm = bpmMap[0].bpm;
                var newSecond = noteEndTime;

                var deltaSeconds = newSecond - currentSecond;

                var speedMultiplier = midiCustomSettings.bpmBasedSpeed ? currentBpm / 120.0 : 1;
                var deltaSize = deltaSeconds * (midiCustomSettings.velocityPerSecond * speedMultiplier);

                currentWidth += deltaSize;
                currentSecond = newSecond;
            }
        }

    } else {
        currentPosition = startTime * midiCustomSettings.velocityPerSecond;
        currentWidth = noteDur * midiCustomSettings.velocityPerSecond;
    }

    return [midiCustomSettings.noteHitXOffset + currentPosition, currentWidth];
}

function getYPositionAndHeightOfKey(pitch) {
    var position = 0;
    var height = 0;
    for (var i = midiCustomSettings.pitchBottomThreshold; i <= pitch; i++) {
        switch (i % 12) {
            case 0: // C
                position += midiCustomSettings.whiteNoteSize;
                break;
            case 1: // C#
                position += (midiCustomSettings.whiteNoteSize / 2) + (midiCustomSettings.blackNoteSize / 2);
                break;
            case 2: // D
                position += (midiCustomSettings.blackNoteSize / 2) + (midiCustomSettings.whiteNoteSize / 2);
                break;
            case 3: // D#
                position += (midiCustomSettings.whiteNoteSize / 2) + (midiCustomSettings.blackNoteSize / 2);
                break;
            case 4: // E
                position += (midiCustomSettings.blackNoteSize / 2) + (midiCustomSettings.whiteNoteSize / 2);
                break;
            case 5: // F
                position += midiCustomSettings.whiteNoteSize;
                break;
            case 6: // F#
                position += (midiCustomSettings.whiteNoteSize / 2) + (midiCustomSettings.blackNoteSize / 2);
                break;
            case 7: // G
                position += (midiCustomSettings.blackNoteSize / 2) + (midiCustomSettings.whiteNoteSize / 2);
                break;
            case 8: // G#
                position += (midiCustomSettings.whiteNoteSize / 2) + (midiCustomSettings.blackNoteSize / 2);
                break;
            case 9: // A
                position += (midiCustomSettings.blackNoteSize / 2) + (midiCustomSettings.whiteNoteSize / 2);
                break;
            case 10: // A#
                position += (midiCustomSettings.whiteNoteSize / 2) + (midiCustomSettings.blackNoteSize / 2);
                break;
            case 11: // B
                position += (midiCustomSettings.blackNoteSize / 2) + (midiCustomSettings.whiteNoteSize / 2);
                break;
        }
    }

    switch (pitch % 12) {
        case 0: // C
            height = midiCustomSettings.whiteNoteSize;
            break;
        case 1: // C#
            height = midiCustomSettings.blackNoteSize;
            break;
        case 2: // D
            height = midiCustomSettings.whiteNoteSize;
            break;
        case 3: // D#
            height = midiCustomSettings.blackNoteSize;
            break;
        case 4: // E
            height = midiCustomSettings.whiteNoteSize;
            break;
        case 5: // F
            height = midiCustomSettings.whiteNoteSize;
            break;
        case 6: // F#
            height = midiCustomSettings.blackNoteSize;
            break;
        case 7: // G
            height = midiCustomSettings.whiteNoteSize;
            break;
        case 8: // G#
            height = midiCustomSettings.blackNoteSize;
            break;
        case 9: // A
            height = midiCustomSettings.whiteNoteSize;
            break;
        case 10: // A#
            height = midiCustomSettings.blackNoteSize;
            break;
        case 11: // B
            height = midiCustomSettings.whiteNoteSize;
            break;
    }
    return [position, height];
}

function getKeyName(pitch) {
    switch (pitch % 12) {
        case 0: // C
            return "C" + Math.floor(pitch / 12);
        case 1: // C#
            return "C#" + Math.floor(pitch / 12);
        case 2: // D
            return "D" + Math.floor(pitch / 12);
        case 3: // D#
            return "D#" + Math.floor(pitch / 12);
        case 4: // E
            return "E" + Math.floor(pitch / 12);
        case 5: // F
            return "F" + Math.floor(pitch / 12);
        case 6: // F#
            return "F#" + Math.floor(pitch / 12);
        case 7: // G
            return "G" + Math.floor(pitch / 12);
        case 8: // G#
            return "G#" + Math.floor(pitch / 12);
        case 9: // A
            return "A" + Math.floor(pitch / 12);
        case 10: // A#
            return "A#" + Math.floor(pitch / 12);
        case 11: // B
            return "B" + Math.floor(pitch / 12);
    }
}

function isBlackNote(pitch) {
    switch (pitch % 12) {
        case 0: // C
            return false;
        case 1: // C#
            return true;
        case 2: // D
            return false;
        case 3: // D#
            return true;
        case 4: // E
            return false;
        case 5: // F
            return false;
        case 6: // F#
            return true;
        case 7: // G
            return false;
        case 8: // G#
            return true;
        case 9: // A
            return false;
        case 10: // A#
            return true;
        case 11: // B
            return false;
    }
}

Number.prototype.countDecimals = function() {
    if (Math.floor(this.valueOf()) === this.valueOf()) return 0;
    return this.toString().split(".")[1].length || 0;
}

function createBpmMap(midiFile) {
    var bpmMap = new Array();
    midiWndw.pb.updateTotal("Creating BPM Map", 25);
    var decimalPlaces = parseInt(midiCustomSettings.bpmChangeThreshold.countDecimals(), 10);
    var amountOfDecimals = Math.pow(10, decimalPlaces);

    for (var i = 0; i < midiFile.tempoMap.length; i++) {
        var second = midiFile.getTime(midiFile.tempoMap[i].tick);
        var bpm = 60000000.0 / midiFile.tempoMap[i].microsecondsPerQuarterNote;
        if (decimalPlaces == 0) {
            var thresholdCurrent = Math.round(i == 0 ? bpmMap[0] : bpmMap[bpmMap.length - 1].bpm);
            var thresholdNext = Math.round(bpm);
        } else {
            var thresholdCurrent = Math.round(i == 0 ? bpmMap[0] : bpmMap[bpmMap.length - 1].bpm * amountOfDecimals) / amountOfDecimals;
            var thresholdNext = Math.round(bpm * amountOfDecimals) / amountOfDecimals;
        }
        if (i == 0 || Math.abs(thresholdNext - thresholdCurrent) >= midiCustomSettings.bpmChangeThreshold) {
            if (decimalPlaces == 0)
                bpmMap.push(new BPM(second, Math.round(bpm), midiFile.tempoMap[i].microsecondsPerQuarterNote));
            else
                bpmMap.push(new BPM(second, Math.round(bpm * amountOfDecimals) / amountOfDecimals, midiFile.tempoMap[i].microsecondsPerQuarterNote));
        }
        if (midiWndw.pb.isCanceled) {
            break;
        }
        midiWndw.pb.updateCurrent("Progress: " + Math.floor(i / midiFile.tempoMap.length * 100) + "% (" + Math.floor(second / 60) + "m" + Math.floor(second) % 60 + "s: " + bpmMap[bpmMap.length - 1].bpm + "BPM)", i / midiFile.tempoMap.length * 100);
    }
    return bpmMap;
}

function createTimeSignatureMap(midiFile) {
    for (var i = 0; i < midiFile.timeSignatureMap.length; i++) {
        var second = midiFile.getTime(midiFile.timeSignatureMap[i].tick);
        midiFile.timeSignatureMap[i].second = second;
    }
    return midiFile.timeSignatureMap;
}

function addScrollerKeyframes(comp, bpmMap, scroller, latestMidiNote) {
    var currentSecond = 0;
    var bpmIndex = 0;
    var currentBpm = bpmMap[bpmIndex].bpm;
    var currentPosition = 0;
    midiWndw.pb.updateCurrent("Adding Scroller Keyframes: 0%", currentSecond);

    if (latestMidiNote == 0) { // This shouldn't ever happen
        Window.alert("Couldn't find the last MIDI note. This means that the scrolling won't work. Please ensure that one of the MIDI files has atleast one note. If you think that this error shouldn't happen, feel free to contact the developer.");
    }

    while (currentSecond != latestMidiNote) {
        currentBpm = bpmMap[bpmIndex].bpm;

        if (bpmIndex + 1 < bpmMap.length && bpmMap[bpmIndex + 1].second < latestMidiNote) {
            var newSecond = bpmMap[bpmIndex + 1].second;
            var deltaSeconds = newSecond - currentSecond;

            var speedMultiplier = midiCustomSettings.bpmBasedSpeed ? currentBpm / 120.0 : 1;
            var newPosition = currentPosition + ((deltaSeconds * (midiCustomSettings.velocityPerSecond * speedMultiplier)) * -1);

            scroller.property("transform").property("position").setValueAtTime(newSecond, [newPosition, comp.height / 2]);

            currentSecond = newSecond;
            currentPosition = newPosition;
            bpmIndex++;
        } else {
            var newSecond = latestMidiNote;
            var deltaSeconds = newSecond - currentSecond;

            var speedMultiplier = midiCustomSettings.bpmBasedSpeed ? currentBpm / 120.0 : 1;
            var newPosition = currentPosition + ((deltaSeconds * (midiCustomSettings.velocityPerSecond * speedMultiplier)) * -1);
            scroller.property("transform").property("position").setValueAtTime(newSecond, [newPosition, comp.height / 2]);

            currentSecond = newSecond;
        }
        midiWndw.pb.updateCurrent("Adding Scroller Keyframes: " + Math.floor((currentSecond / latestMidiNote) * 100) + "%", (currentSecond / latestMidiNote) * 100);
        if (midiWndw.pb.isCanceled) {
            break;
        }
    }
}

function MidiConfig(file) {
    this.filePath = file.absoluteURI;
    this.fileName = File.decode(file.name);
    this.name = this.fileName.split(".")[0];
    this.selectedColorIndex = 0;
}

// Color in RGB (0 - 255) because that's easier TODO: Support 0-1, 0-255 and #hex values
function PresetColor(name, color) {
    this.name = name;
    this.color = [color[0] / 255, color[1] / 255, color[2] / 255, 1];
}

function MidiCustomSettings() {
    // General //
    // Composition
    this.scrollCompFramerate = 60;
    this.noteCompFramerate = 30;
    this.resolutionWidth = 1920;
    this.resolutionHeight = 1080;
    // BPM Text
    this.createBpmText = false;
    this.bpmTextFont = "Arial";
    this.bpmTextFontSize = 32;

    // Notes //
    // Position
    this.noteHitXOffset = 192; // X offset for the note activation, starting from the left
    this.noteYOffset = 0; // Y offset for notes, starting from the bottom

    this.pitchBottomThreshold = 21; // Offset for determining Y position. 21 is A0
    this.pitchTopThreshold = 108; // Offset for determining Y position. 127 is G9, 108 is C8
    this.whiteNoteSize = 10; // Size of the white notes (non-sharpened)
    this.blackNoteSize = 8; // Size of the black notes (sharpened)

    // Effects & Animation
    this.velocityPerSecond = 192; // Speed of the notes in pixels per second
    this.bpmBasedSpeed = true; // Is the speed affected by BPM? (Based on 120BPM)

    this.fadeOutDuration = 2.5; // Threshold for the duration a note needs to have to set the opacity to 0 over its duration
    this.fadeOutTime = 1; // The time it takes to fade out once a note finished playing

    this.darkenBlackNotes = true // Should black notes be darkened?
    this.darkenAmount = 20; // The amount of darkening

    this.dropShadowBlurSize = 16; // The amount of softness applied to the dropShadow effect of the notes.

    // BarLines //
    // Position
    this.barLineYPos = 164;
    this.barLineBarHeight = 48;
    this.barLineBeatHeight = 16;
    // Font
    this.barLineFont = "Arial-BoldMT";
    this.barLineFontSize = 36;

    // PianoKeys
    this.pianoKeysCreateIndicator = true;
    this.pianoKeysCreateKeys = true;
    this.pianoKeysIndicatorWidth = 4;
    this.pianoKeysGapSize = 32;
    this.pianoKeysWhiteKeyWidth = 24;
    this.pianoKeysBlackKeyWidth = 16;
    // Font
    this.pianoKeysFont = "Arial-BoldMT";
    this.pianoKeysFontSize = 22;

    // Advanced
    this.bpmSourceIndex = 0; // The index of the MIDI file to take the tempo map from
    this.timeSigSourceIndex = 0; // The index of the MIDI file to take the time sig from

    this.trailingDuration = 2.5; // Additional time it scrolls after the last note was played.

    this.bpmChangeThreshold = 1; // Depending on the tempo mapping, this needs to be increased.
    //E.g. with a threshold of 1, a change in BPM will only register if there is at least a 1 second difference.


    // These are material colors at 800 weight
    // TODO: Read and write these to the settings file
    this.presetColors = [
        new PresetColor("Green", [46, 125, 50]),
        new PresetColor("Red", [198, 40, 40]),
        new PresetColor("Blue", [21, 101, 192]),
        new PresetColor("Orange", [230, 81, 0]),
        new PresetColor("Cyan", [0, 131, 143]),
        new PresetColor("Yellow", [249, 168, 37]),
        new PresetColor("Pink", [173, 20, 87]),
        new PresetColor("Purple", [106, 27, 154]),
        new PresetColor("Teal", [0, 105, 92]),
        new PresetColor("Light Green", [85, 139, 47]),
        new PresetColor("Lime", [158, 157, 36]),
        new PresetColor("Brown", [78, 52, 46]),
        new PresetColor("Grey", [66, 66, 66]),
        new PresetColor("Blue Grey", [55, 71, 79])
    ];

    this.readFromXml = function(xmlObj) {
        try {
            this.scrollCompFramerate = parseInt(xmlObj.settings.scrollCompFramerate, 10);
            this.noteCompFramerate = parseInt(xmlObj.settings.noteCompFramerate, 10);
            this.resolutionWidth = parseInt(xmlObj.settings.resolutionWidth, 10);
            this.resolutionHeight = parseInt(xmlObj.settings.resolutionHeight, 10);

            this.bpmTextFont = xmlObj.settings.bpmTextFont;
            this.bpmTextFontSize = parseInt(xmlObj.settings.bpmTextFontSize, 10);
            this.createBpmText = xmlObj.settings.createBpmText == "true" ? true : false;

            this.noteHitXOffset = parseInt(xmlObj.settings.noteHitXOffset, 10);
            this.noteYOffset = parseInt(xmlObj.settings.noteYOffset, 10);
            this.pitchBottomThreshold = parseInt(xmlObj.settings.pitchBottomThreshold, 10);
            this.pitchTopThreshold = parseInt(xmlObj.settings.pitchTopThreshold, 10);

            this.whiteNoteSize = parseInt(xmlObj.settings.whiteNoteSize, 10);
            this.blackNoteSize = parseInt(xmlObj.settings.blackNoteSize, 10);

            this.velocityPerSecond = parseInt(xmlObj.settings.velocityPerSecond, 10);
            this.bpmBasedSpeed = xmlObj.settings.bpmBasedSpeed == "true" ? true : false;
            this.fadeOutDuration = parseFloat(xmlObj.settings.fadeOutDuration);
            this.fadeOutTime = parseFloat(xmlObj.settings.fadeOutTime);

            this.darkenBlackNotes = xmlObj.settings.darkenBlackNotes == "true" ? true : false;
            this.darkenAmount = parseInt(xmlObj.settings.darkenAmount, 10);
            this.dropShadowBlurSize = parseInt(xmlObj.settings.dropShadowBlurSize, 10);

            this.barLineYPos = parseInt(xmlObj.barLines.barLineYPos, 10);
            this.barLineBarHeight = parseInt(xmlObj.barLines.barLineBarHeight, 10);
            this.barLineBeatHeight = parseInt(xmlObj.barLines.barLineBeatHeight, 10);
            this.barLineFont = xmlObj.barLines.barLineFont;
            this.barLineFontSize = parseInt(xmlObj.barLines.barLineFontSize, 10);

            this.pianoKeysCreateIndicator = xmlObj.pianoKeys.pianoKeysCreateIndicator == "true" ? true : false;
            this.pianoKeysCreateKeys = xmlObj.pianoKeys.pianoKeysCreateKeys == "true" ? true : false;
            this.pianoKeysIndicatorWidth = parseInt(xmlObj.pianoKeys.pianoKeysIndicatorWidth, 10);
            this.pianoKeysGapSize = parseInt(xmlObj.pianoKeys.pianoKeysGapSize, 10);
            this.pianoKeysWhiteKeyWidth = parseInt(xmlObj.pianoKeys.pianoKeysWhiteKeyWidth, 10);
            this.pianoKeysBlackKeyWidth = parseInt(xmlObj.pianoKeys.pianoKeysBlackKeyWidth, 10);
            this.pianoKeysFont = xmlObj.pianoKeys.pianoKeysFont;
            this.pianoKeysFontSize = parseInt(xmlObj.pianoKeys.pianoKeysFontSize, 10);


            this.bpmSourceIndex = parseInt(xmlObj.settings.bpmSourceIndex, 10);
            this.timeSigSourceIndex = parseInt(xmlObj.settings.timeSigSourceIndex, 10);
            this.trailingDuration = parseFloat(xmlObj.settings.trailingDuration);
            this.bpmChangeThreshold = parseFloat(xmlObj.settings.bpmChangeThreshold);
        } catch (error) {
            Window.alert("An error occured while reading the settings file.\n\nMessage: " + error.message + "\n\nDefault settings will be used.")
            this.revertToDefaultValues();
            return false;
        }
        return true;
    }

    this.saveToXml = function(xmlObj) {
        if (xmlObj == undefined || xmlObj != typeof XML) {
            xmlObj = new XML("<configuration><settings></settings></configuration>");
            xmlObj.filePath = getCurrentWorkingDirectory() + "\\pq_midi_settings.xml"
        }
        xmlObj.settings.scrollCompFramerate = this.scrollCompFramerate;
        xmlObj.settings.noteCompFramerate = this.noteCompFramerate;
        xmlObj.settings.resolutionWidth = this.resolutionWidth;
        xmlObj.settings.resolutionHeight = this.resolutionHeight;

        xmlObj.settings.bpmTextFont = this.bpmTextFont;
        xmlObj.settings.bpmTextFontSize = this.bpmTextFontSize;
        xmlObj.settings.createBpmText = this.createBpmText;

        xmlObj.settings.noteHitXOffset = this.noteHitXOffset;
        xmlObj.settings.noteYOffset = this.noteYOffset;
        xmlObj.settings.pitchBottomThreshold = this.pitchBottomThreshold;
        xmlObj.settings.pitchTopThreshold = this.pitchTopThreshold;
        xmlObj.settings.whiteNoteSize = this.whiteNoteSize;
        xmlObj.settings.blackNoteSize = this.blackNoteSize;

        xmlObj.settings.velocityPerSecond = this.velocityPerSecond;
        xmlObj.settings.bpmBasedSpeed = this.bpmBasedSpeed;
        xmlObj.settings.fadeOutDuration = this.fadeOutDuration;
        xmlObj.settings.fadeOutTime = this.fadeOutTime;

        xmlObj.settings.darkenBlackNotes = this.darkenBlackNotes;
        xmlObj.settings.darkenAmount = this.darkenAmount;
        xmlObj.settings.dropShadowBlurSize = this.dropShadowBlurSize;

        xmlObj.barLines.barLineYPos = this.barLineYPos;
        xmlObj.barLines.barLineBarHeight = this.barLineBarHeight;
        xmlObj.barLines.barLineBeatHeight = this.barLineBeatHeight;
        xmlObj.barLines.barLineFont = this.barLineFont;
        xmlObj.barLines.barLineFontSize = this.barLineFontSize;

        xmlObj.pianoKeys.pianoKeysCreateIndicator = this.pianoKeysCreateIndicator;
        xmlObj.pianoKeys.pianoKeysCreateKeys = this.pianoKeysCreateKeys;
        xmlObj.pianoKeys.pianoKeysIndicatorWidth = this.pianoKeysIndicatorWidth;
        xmlObj.pianoKeys.pianoKeysGapSize = this.pianoKeysGapSize;
        xmlObj.pianoKeys.pianoKeysWhiteKeyWidth = this.pianoKeysWhiteKeyWidth;
        xmlObj.pianoKeys.pianoKeysBlackKeyWidth = this.pianoKeysBlackKeyWidth;
        xmlObj.pianoKeys.pianoKeysFont = this.pianoKeysFont;
        xmlObj.pianoKeys.pianoKeysFontSize = this.pianoKeysFontSize;

        xmlObj.settings.bpmSourceIndex = this.bpmSourceIndex;
        xmlObj.settings.timeSigSourceIndex = this.timeSigSourceIndex;
        xmlObj.settings.trailingDuration = this.trailingDuration;
        xmlObj.settings.bpmChangeThreshold = this.bpmChangeThreshold;
        if (hasWriteAndNetworkAccess()) {
            try {
                var file = new File(xmlObj.filePath);
                file.open("w");
                file.write(xmlObj.toString());
                file.close();
            } catch (error) {
                Window.alert("An error occured while writing to the settings file.\n\n" + error.message);
                return false;
            }
            return true;
        }
        return false;
    }

    this.revertToDefaultValues = function() {
        this.scrollCompFramerate = 60;
        this.noteCompFramerate = 30;
        this.resolutionWidth = 1920;
        this.resolutionHeight = 1080;

        this.createBpmText = false;
        this.bpmTextFont = "Arial";
        this.bpmTextFontSize = 32;

        this.noteHitXOffset = 192;
        this.noteYOffset = 0;
        this.pitchBottomThreshold = 21;
        this.pitchTopThreshold = 108;
        this.whiteNoteSize = 10;
        this.blackNoteSize = 8;

        this.velocityPerSecond = 192;
        this.bpmBasedSpeed = true;
        this.fadeOutDuration = 2.5;
        this.fadeOutTime = 1;

        this.darkenBlackNotes = true;
        this.darkenAmount = 20;

        this.dropShadowBlurSize = 16;

        this.barLineYPos = 164;
        this.barLineBarHeight = 48;
        this.barLineBeatHeight = 16;
        this.barLineFont = "Arial-BoldMT";
        this.barLineFontSize = 36;

        this.pianoKeysCreateIndicator = true;
        this.pianoKeysCreateKeys = true;
        this.pianoKeysIndicatorWidth = 4;
        this.pianoKeysGapSize = 32;
        this.pianoKeysWhiteKeyWidth = 24;
        this.pianoKeysBlackKeyWidth = 16;
        this.pianoKeysFont = "Arial-BoldMT";
        this.pianoKeysFontSize = 22;

        this.bpmSourceIndex = 0;
        this.timeSigSourceIndex = 0;
        this.trailingDuration = 2.5;
        this.bpmChangeThreshold = 1;
    }
}

function getCurrentWorkingDirectory() {
    return (new File($.fileName)).parent.fsName;
}

function readSettingsFile() {
    var filePath = getCurrentWorkingDirectory() + "\\pq_midi_settings.xml";
    var xmlFile = new File(filePath);
    if (!xmlFile.open("r")) {
        //Window.alert("The settings file is missing - default settings will be used.\n\nIf you don't want to use the settings file at all, go to the first line of this script and change it into \n\'var USE_MIDI_SETTINGS_FILE = false;\'");
        return false;
    }
    var xmlString = xmlFile.read();
    if (!xmlFile.close()) {
        Window.alert("An error occured while closing the settings file - default settings will be used.");
        return false;
    }
    try {
        var xmlObj = new XML(xmlString);
    } catch (error) {
        Window.alert("An error occured while reading the settings file.\n\nMessage: " + error.message);
        return false;
    }
    xmlObj.filePath = filePath;
    return xmlObj;
}

// Slightly modified version of:
// https://community.adobe.com/t5/after-effects/how-can-i-check-whether-if-quot-allow-scripts-to-write-files-and-access-network-quot-is-enable-using/td-p/10869640?page=1

function hasWriteAndNetworkAccess() {
    var appVersion, commandID, scriptName, tabName;

    appVersion = parseFloat(app.version);

    commandID = 2359;
    tabName = 'General';
    if (appVersion >= 16.1) {
        commandID = 3131;
        tabName = 'Scripting & Expressions';
    }

    if (isSecurityPrefSet()) return true;

    scriptName = $.fileName;
    Window.alert("\'" + scriptName.split("/").pop() + "\'" + ' requires access to write files and perform network operations.\n' +
        'Go to the "' + tabName + '" panel of the application preferences and make sure ' +
        '"Allow Scripts to Write Files and Access Network" is checked.');

    app.executeCommand(commandID);

    return isSecurityPrefSet();

    function isSecurityPrefSet() {
        return app.preferences.getPrefAsLong(
            'Main Pref Section',
            'Pref_SCRIPTING_FILE_NETWORK_SECURITY'
        ) === 1;
    }
}

function handleSelectionUpdate() {
    if (midiWndw.midiContainer.midiListBox.selection != null) {
        var selection = getSelectedIndices();

        midiWndw.findElement("selectionText").text = "Selection: " + getSelectedText(false);
        midiWndw.findElement("midiNameEditText").text = getSelectedText(true);
        colorDropdownList.selection = midiConfigs[selection[0].index].selectedColorIndex;

        midiWndw.midiContainer.configGroup.visible = true;
    } else {
        midiWndw.findElement("selectionText").text = "Nothing selected.\nYou can select multiple items by holding CTRL/Command or a line of items by holding Shift.\n" +
            "Note: If you have trouble selecting items, make sure to hover over the actual text!";
        midiWndw.midiContainer.configGroup.visible = false;
    }
}

function getSelectedIndices() {
    return midiWndw.midiContainer.midiListBox.selection;
}

function setColorForSelectedConfigs(colorIndex) {
    var selection = getSelectedIndices();
    for (var i = 0; i < selection.length; i++) {
        midiConfigs[selection[i].index].selectedColorIndex = colorIndex;
    }
    updateListBoxData();
}

function getSelectedText(emptyIfMultiselect) {
    var selection = getSelectedIndices();
    var isSame = true;
    var name = midiConfigs[selection[0].index].name;
    for (var i = 0; i < selection.length; i++) {
        if (midiConfigs[selection[i].index].name != name) {
            isSame = false;
            name = emptyIfMultiselect ? "" : "Different names selected";
            break;
        }
        name = midiConfigs[selection[i].index].name;
    }
    return name + (emptyIfMultiselect ? "" : " (" + selection.length + " selected)");
}

function getColorNameOfIndex(index) {
    return colorDropdownList.items[index].toString();
}

function updateListBoxData() {
    var selection = getSelectedIndices();
    for (var i = 0; i < selection.length; i++) {
        selection[i].text = midiConfigs[selection[i].index].name + " (" + midiConfigs[selection[i].index].fileName + ")" + " \/\/ Color: " + getColorNameOfIndex(midiConfigs[selection[i].index].selectedColorIndex);
    }
}

function createBarLines(timeSigMap, bpmMap, tempoMap, timeDivision, latestMidiNote) {
    midiWndw.pb.updateTotal("Creating Bar Lines", 35);

    var currentTime = 0;
    var currentBpm = bpmMap[0];

    var scrollerComp = app.project.items.addComp("_BarLines Scroller", midiCustomSettings.resolutionWidth, midiCustomSettings.resolutionHeight, 1.0, latestMidiNote, midiCustomSettings.scrollCompFramerate);
    var scroller = scrollerComp.layers.addNull();
    scroller.name = "Scroller";
    scroller.property("transform").property("position").setValueAtTime(0, [0, scrollerComp.height / 2]);
    scroller.property("transform").property("position").setSpatialAutoBezierAtKey(1, false);

    if (midiCustomSettings.bpmBasedSpeed)
        addScrollerKeyframes(scrollerComp, bpmMap, scroller, latestMidiNote);
    else
        scroller.property("transform").property("position").setValueAtTime(latestMidiNote, [(latestMidiNote * midiCustomSettings.velocityPerSecond) * -1, scrollerComp.height / 2]);

    var comp = app.project.items.addComp("BarLines", midiCustomSettings.resolutionWidth, midiCustomSettings.resolutionHeight, 1.0, latestMidiNote, 30);
    var compLayer = scrollerComp.layers.add(comp);
    compLayer.parent = scroller;

    // This makes it so that the comps don't get cropped off
    compLayer.collapseTransformation = true;

    var tempoIndex = 0;
    var timeSigIndex = 0;
    var currentTick = 0;

    var yPos = midiCustomSettings.barLineYPos;
    var barHeight = midiCustomSettings.barLineBarHeight;
    var beatHeight = midiCustomSettings.barLineBeatHeight;

    var stepNumber = 1;
    var barNumber = 1;
    var currentMicrosecondsPerQuarterNote = tempoMap[0].microsecondsPerQuarterNote;

    var metronomeTickCount = (midiWndw.halfSpeedCheckbox.value == true ? 2 : 1) * Math.floor((timeDivision * (4 / timeSigMap[timeSigIndex].denominator)));
    var metronomeTickDeltaSeconds = (currentMicrosecondsPerQuarterNote * metronomeTickCount) / timeDivision / 1000000;
    var tCounter = 0;
    while (currentTime <= latestMidiNote) {
        var deltaSeconds = 0;

        var prevTickCounter = currentTick;
        var deltaTickCounter = 0;

        var targetTick = currentTick + (midiWndw.halfSpeedCheckbox.value == true ? 2 : 1) * Math.floor((timeDivision * (4 / timeSigMap[timeSigIndex].denominator)));

        while (currentTick < targetTick) {
            if (timeSigIndex + 1 < timeSigMap.length && currentTick + (targetTick - currentTick) >= timeSigMap[timeSigIndex + 1].tick) {
                // TODO: Test if this part actually works
                timeSigIndex++;
                stepNumber = 1;
                barNumber++;

                currentTick = timeSigMap[timeSigIndex].tick;
                deltaTickCounter = currentTick - prevTickCounter;

                var metronomeTickCount = (midiWndw.halfSpeedCheckbox.value == true ? 2 : 1) * Math.floor((timeDivision * (4 / timeSigMap[timeSigIndex].denominator)));
                var metronomeTickDeltaSeconds = (currentMicrosecondsPerQuarterNote * metronomeTickCount) / timeDivision / 1000000;

                deltaSeconds += (midiWndw.halfSpeedCheckbox.value == true ? 0.5 : 1) * (currentMicrosecondsPerQuarterNote * deltaTickCounter) / timeDivision / 1000000;
                prevTickCounter = currentTick;
                break;
            }
            currentMicrosecondsPerQuarterNote = (midiWndw.halfSpeedCheckbox.value == true ? 2 : 1) * tempoMap[tempoIndex].microsecondsPerQuarterNote;
            do {
                if (tempoIndex < tempoMap.length) {
                    if (tempoIndex + 1 >= tempoMap.length) {
                        currentTick = targetTick;
                    } else if (targetTick <= tempoMap[tempoIndex + 1].tick) {
                        currentTick = targetTick;
                    } else {
                        currentTick = tempoMap[tempoIndex + 1].tick;
                        tempoIndex++;
                    }
                } else {
                    currentTick = targetTick;
                }
                deltaTickCounter = currentTick - prevTickCounter;
                deltaSeconds += (midiWndw.halfSpeedCheckbox.value == true ? 0.5 : 1) * (currentMicrosecondsPerQuarterNote * deltaTickCounter) / timeDivision / 1000000;
                prevTickCounter = currentTick;
            } while (tempoIndex + 1 < tempoMap.length && targetTick > tempoMap[tempoIndex + 1].tick);
        }
        if (stepNumber > timeSigMap[timeSigIndex].numerator) {
            stepNumber = 1;
            barNumber++;
        }

        var speedMultiplier = midiCustomSettings.bpmBasedSpeed ? (60000000.0 / tempoMap[0].microsecondsPerQuarterNote) / 120.0 : 1;
        var xPos = midiCustomSettings.noteHitXOffset + ((metronomeTickDeltaSeconds * tCounter) * midiCustomSettings.velocityPerSecond * speedMultiplier);
        tCounter++;

        if (stepNumber == 1) {
            var barTextLayer = comp.layers.addText();
            var barText = barTextLayer.property("Source Text");

            var barTextDocument = new TextDocument(barNumber);
            barText.setValue(barTextDocument);
            barTextDocument = barText.value;
            barTextDocument.font = midiCustomSettings.barLineFont;
            barTextDocument.justification = ParagraphJustification.LEFT_JUSTIFY;
            barTextDocument.fillColor = [1, 1, 1];
            barTextDocument.fontSize = midiCustomSettings.barLineFontSize;
            barText.setValue(barTextDocument);

            barTextLayer.property("transform").property("position").setValue([xPos + 16, yPos + barHeight]);
        }
        var height = stepNumber == 1 ? barHeight : beatHeight;
        var solid = comp.layers.addSolid([1, 1, 1], barNumber + ":" + stepNumber + " (" + Math.floor(currentTime / 60) + "m" + Math.floor(currentTime) % 60 + "s, " + tempoMap[tempoIndex].microsecondsPerQuarterNote + " ms/qn)", 4, height, 1.0);
        solid.property("transform").property("position").setValue([xPos, yPos]);
        solid.property("transform").property("anchorPoint").setValue([2, 0]);

        midiWndw.pb.updateCurrent("Progress: " + Math.floor(currentTime / latestMidiNote * 100) + "% (" + Math.floor(currentTime / 60) + "m" + Math.floor(currentTime) % 60 + "s, " + barNumber + ":" + stepNumber + ") " + deltaSeconds, currentTime / latestMidiNote * 100);

        currentTime += deltaSeconds;
        stepNumber++;
        if (midiWndw.pb.isCanceled) {
            break;
        }
    }
    return comp;
}

function createPianoKeys() {
    midiWndw.pb.updateTotal("Creating Piano Keys", 50);
    var comp = app.project.items.addComp("PianoKeys", midiCustomSettings.resolutionWidth, midiCustomSettings.resolutionHeight, 1.0, 2, 1);

    var indicatorWidth = midiCustomSettings.pianoKeysIndicatorWidth;
    var gapSize = midiCustomSettings.pianoKeysGapSize;
    if (midiCustomSettings.pianoKeysCreateIndicator) {
        var noteOnIndicator = comp.layers.addSolid([1, 1, 1], "NoteOnIndicator", indicatorWidth, comp.height, 1.0);
        noteOnIndicator.property("transform").property("position").setValue([midiCustomSettings.noteHitXOffset - (indicatorWidth / 2), comp.height / 2]);
    }
    if (midiCustomSettings.pianoKeysCreateKeys) {
        for (var i = midiCustomSettings.pitchBottomThreshold; i <= midiCustomSettings.pitchTopThreshold; i++) {
            var yPos = midiCustomSettings.resolutionHeight - getYPositionAndHeightOfKey(i)[0];

            if (i % 12 == 0) { // Is it a C?
                var width = midiCustomSettings.pianoKeysWhiteKeyWidth;

                var cKeyTextLayer = comp.layers.addText();
                var cKeyText = cKeyTextLayer.property("Source Text");

                var cKeyTextDocument = new TextDocument("C" + Math.floor(i / 12));
                cKeyText.setValue(cKeyTextDocument);
                cKeyTextDocument = cKeyText.value;
                cKeyTextDocument.font = midiCustomSettings.pianoKeysFont;
                cKeyTextDocument.justification = ParagraphJustification.RIGHT_JUSTIFY;
                cKeyTextDocument.fillColor = [1, 1, 1];
                cKeyTextDocument.fontSize = midiCustomSettings.pianoKeysFontSize;
                cKeyText.setValue(cKeyTextDocument);

                var xPos = ((midiCustomSettings.noteHitXOffset - (indicatorWidth / 2)) + width / 2) - gapSize;
                cKeyTextLayer.property("transform").property("position").setValue([xPos - 24, yPos + cKeyTextLayer.sourceRectAtTime(0, true).height / 2]);
            } else {
                var width = isBlackNote(i) ? midiCustomSettings.pianoKeysBlackKeyWidth : midiCustomSettings.pianoKeysWhiteKeyWidth;
                var xPos = ((midiCustomSettings.noteHitXOffset - (indicatorWidth / 2)) + width / 2) - gapSize;
            }
            var key = comp.layers.addSolid([1, 1, 1], i, width,
                isBlackNote(i) ? midiCustomSettings.blackNoteSize / 2 : midiCustomSettings.whiteNoteSize / 2, 1.0);

            key.property("transform").property("position").setValue([xPos, yPos]);
            var progress = (i - midiCustomSettings.pitchBottomThreshold) / (midiCustomSettings.pitchTopThreshold - midiCustomSettings.pitchBottomThreshold);
            midiWndw.pb.updateCurrent("Progress: " + Math.floor(progress * 100) + "%", progress * 100);

            if (midiWndw.pb.isCanceled) {
                break;
            }
        }
    }
    return comp;
}

function createBpmText(masterComp, bpmMap) {
    var bpmText = masterComp.layers.addText().property("Source Text");

    var bpmTextDocument = bpmText.value;
    bpmTextDocument.resetCharStyle();
    bpmTextDocument.fillColor = [1, 1, 1];
    bpmTextDocument.fontSize = midiCustomSettings.bpmTextFontSize;
    bpmTextDocument.font = midiCustomSettings.bpmTextFont;
    bpmTextDocument.justification = ParagraphJustification.LEFT_JUSTIFY;
    bpmText.setValue(bpmTextDocument);

    midiWndw.pb.updateTotal("Adding BPM Text Keyframes", 70);

    var previousValue = 0;
    for (var i = 0; i < bpmMap.length; i++) {
        var newValue = Math.floor(bpmMap[i].bpm);
        if (newValue != previousValue) { // Only set keyframes when the whole number changes to avoid blowing After Effects up
            bpmTextDocument.text = newValue;
            bpmText.setValueAtTime(bpmMap[i].second, bpmTextDocument);
        }
        if (midiWndw.pb.isCanceled)
            break;

        previousValue = newValue;

        midiWndw.pb.updateCurrent("Progress: " + Math.floor((((i + 1) / bpmMap.length) * 100)) + "% (" + Math.floor(bpmMap[i].second / 60) + "m" + Math.floor(bpmMap[i].second) % 60 + "s: " + bpmMap[i].bpm + "BPM)", ((i + 1) / bpmMap.length) * 100);
    }
}

function createVisualizer() {
    app.beginUndoGroup("Generate MIDI Visualizer");

    midiWndw.update();
    midiWndw.pb.start();

    // Read MIDI files first because we need some information
    var parsedMidiFiles = readMidiFiles();
    var latestMidiNote = getLatestMidiNote(parsedMidiFiles);

    var masterComp = app.project.items.addComp("MidiMaster", midiCustomSettings.resolutionWidth, midiCustomSettings.resolutionHeight, 1.0, latestMidiNote, midiCustomSettings.scrollCompFramerate);
    if (midiCustomSettings.bpmSourceIndex < 0)
        midiCustomSettings.bpmSourceIndex = 0;
    if (midiCustomSettings.bpmSourceIndex + 1 > parsedMidiFiles.length)
        midiCustomSettings.bpmSourceIndex = parsedMidiFiles.length - 1;

    if (midiCustomSettings.timeSigSourceIndex < 0)
        midiCustomSettings.timeSigSourceIndex = 0;
    if (midiCustomSettings.timeSigSourceIndex + 1 > parsedMidiFiles.length)
        midiCustomSettings.timeSigSourceIndex = parsedMidiFiles.length - 1;

    var bpmMap = createBpmMap(parsedMidiFiles[midiCustomSettings.bpmSourceIndex]);
    var timeSigMap = createTimeSignatureMap(parsedMidiFiles[midiCustomSettings.timeSigSourceIndex]);

    createBarLines(timeSigMap, bpmMap, parsedMidiFiles[midiCustomSettings.bpmSourceIndex].tempoMap, parsedMidiFiles[midiCustomSettings.bpmSourceIndex].timeDivision, latestMidiNote);
    if (midiCustomSettings.pianoKeysCreateKeys || midiCustomSettings.pianoKeysCreateIndicator)
        createPianoKeys();
    if (midiCustomSettings.createBpmText)
        createBpmText(masterComp, bpmMap);

    if (!midiWndw.pb.isCanceled) {
        for (var i = 0; i < parsedMidiFiles.length; i++) {
            latestMidiNote = getLatestMidiNote(parsedMidiFiles[i]);

            var scrollerComp = app.project.items.addComp("_" + midiConfigs[i].name + " Scroller", midiCustomSettings.resolutionWidth, midiCustomSettings.resolutionHeight, 1.0, latestMidiNote, midiCustomSettings.scrollCompFramerate);
            var scroller = scrollerComp.layers.addNull();
            scroller.name = "Scroller";
            scroller.property("transform").property("position").setValueAtTime(0, [0, scrollerComp.height / 2]);
            scroller.property("transform").property("position").setSpatialAutoBezierAtKey(1, false);

            if (midiCustomSettings.bpmBasedSpeed)
                addScrollerKeyframes(scrollerComp, bpmMap, scroller, latestMidiNote);
            else
                scroller.property("transform").property("position").setValueAtTime(latestMidiNote, [(latestMidiNote * midiCustomSettings.velocityPerSecond) * -1, scrollerComp.height / 2]);

            midiWndw.pb.updateTotal("Processing " + midiConfigs[i].name + " (" + (i + 1) + "/" + parsedMidiFiles.length + ")", ((i + 1) / parsedMidiFiles.length) * 100);

            var comp = app.project.items.addComp(midiConfigs[i].name + " notes", midiCustomSettings.resolutionWidth, midiCustomSettings.resolutionHeight, 1.0, latestMidiNote, midiCustomSettings.noteCompFramerate);
            var compLayer = scrollerComp.layers.add(comp);
            compLayer.parent = scroller;
            // This makes it so that the comps don't get cropped off
            compLayer.collapseTransformation = true;

            if (midiCustomSettings.dropShadowBlurSize != 0) {
                var dropShadow = compLayer.property("Effects").addProperty("ADBE Drop Shadow");
                dropShadow.property("distance").setValue(0);
                dropShadow.property("softness").setValue(midiCustomSettings.dropShadowBlurSize);
            }

            var currentMidi = parsedMidiFiles[i];

            var notesCount = currentMidi.notes.length;

            var latestMidiNote = 0;
            for (var j = 0; j < notesCount; j++) {
                if (currentMidi.notes[j].vel && currentMidi.notes[j].durTime) {
                    var noteTime = currentMidi.notes[j].time;
                    var noteDur = currentMidi.notes[j].durTime;
                    var notePitch = currentMidi.notes[j].pitch;

                    var shape = comp.layers.addShape();

                    var contents = shape.property("Contents");
                    contents.addProperty("ADBE Vector Shape - Rect");

                    // Darken black notes
                    if (midiCustomSettings.darkenBlackNotes && isBlackNote(notePitch)) {
                        var darkFill = contents.addProperty("ADBE Vector Graphic - Fill");
                        darkFill.property("ADBE Vector Fill Color").setValue([0, 0, 0, 1]);
                        darkFill.property("Opacity").setValue(midiCustomSettings.darkenAmount);
                    }

                    var fillProp = contents.addProperty("ADBE Vector Graphic - Fill");
                    if (noteTime != 0) {
                        fillProp.property("ADBE Vector Fill Color").setValueAtTime(0, [1, 1, 1, 1]);
                    }
                    var xPosAndWidth = getXPositionAndWidthOfNote(noteTime, noteDur, bpmMap);
                    var yPosAndHeight = getYPositionAndHeightOfKey(notePitch);

                    shape.property("transform").property("position").setValue([xPosAndWidth[0], midiCustomSettings.resolutionHeight - yPosAndHeight[0]]);
                    shape.property("transform").property("anchorPoint").setValue([xPosAndWidth[1] * -0.5, 0]);

                    contents.property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Size").setValue([xPosAndWidth[1], yPosAndHeight[1]]);
                    contents.property("ADBE Vector Shape - Rect").property("ADBE Vector Rect Roundness").setValue(yPosAndHeight[1] / 4);

                    if (noteTime != 0) {
                        // Initial opacity and scale
                        shape.property("transform").property("opacity").setValueAtTime(0, 25);
                        shape.property("transform").property("opacity").setInterpolationTypeAtKey(1, KeyframeInterpolationType.HOLD);
                        shape.property("transform").property("scale").setValueAtTime(0, [100, 100]);
                        shape.property("transform").property("scale").setInterpolationTypeAtKey(1, KeyframeInterpolationType.HOLD);
                    }

                    // Note start opacity
                    shape.property("transform").property("opacity").setValueAtTime(noteTime, 80);
                    shape.property("transform").property("opacity").setInterpolationTypeAtKey(noteTime == 0 ? 1 : 2, KeyframeInterpolationType.LINEAR);
                    // Note opacity over duration
                    var fadeAmount = Math.max(100 - ((noteDur / midiCustomSettings.fadeOutDuration) * 100), 20);
                    shape.property("transform").property("opacity").setValueAtTime(noteTime + noteDur, fadeAmount);
                    shape.property("transform").property("opacity").setValueAtTime(noteTime + noteDur + midiCustomSettings.fadeOutTime, 0);
                    // Note end opacity
                    var keyIndex = shape.property("transform").property("opacity").nearestKeyIndex(noteTime + noteDur + midiCustomSettings.fadeOutTime);
                    shape.property("transform").property("opacity").setTemporalEaseAtKey(keyIndex, [new KeyframeEase(0, 0.33)]);
                    // Note start fill color
                    fillProp.property("ADBE Vector Fill Color").setValueAtTime(noteTime, midiCustomSettings.presetColors[midiConfigs[i].selectedColorIndex].color);
                    fillProp.property("ADBE Vector Fill Color").setInterpolationTypeAtKey(1, KeyframeInterpolationType.HOLD);
                    // Note start scale
                    shape.property("transform").property("scale").setValueAtTime(noteTime, [100, 125]);
                    shape.property("transform").property("scale").setInterpolationTypeAtKey(noteTime == 0 ? 1 : 2, KeyframeInterpolationType.LINEAR);
                    shape.property("transform").property("scale").setValueAtTime(noteTime + 0.2, [100, 100]);

                    shape.name = "(" + j + ") " + "Time: " + noteTime + ", Vel: " + currentMidi.notes[j].vel + ", pitch: " + notePitch + ", channel: " + currentMidi.notes[j].channel + ", Dur: " + noteDur;
                }
                midiWndw.pb.updateCurrent((j + 1) + "/" + notesCount + " note events processed", ((j + 1) / notesCount) * 100);
                if (midiWndw.pb.isCanceled) {
                    break;
                }
            }
            if (midiWndw.pb.isCanceled) {
                break;
            }
        }
    }

    app.endUndoGroup();

    if (midiWndw.pb.isCanceled) {
        // Window.alert("Process was canceled and will undo the operations.");
        // app.executeCommand(16); // 16 is undo. Check https://www.provideocoalition.com/wp-content/uploads/AECC2015_MenuIDs_v1_0_1-1.pdf
        // This doesn't work for some reason

        Window.alert("Process was canceled.\nYou can undo all actions using CTRL + Z or Edit -> Undo Generate MIDI Visualizer.");
        midiWndw.pb.updateTotal("Process was canceled", 100);
    } else {
        midiWndw.pb.updateTotal(midiConfigs.length + " MIDI files processed.", 100);
    }

    midiWndw.pb.stop();

    midiWndw.pb.updateCurrent("All done! It took " + Math.floor(midiWndw.pb.deltaTime / 60) + "m" + midiWndw.pb.deltaTime % 60 + "s to process.", 100);
}

// window config //

// Use dialog instead of palette, otherwise the whole application will become
// unresponsive during the creation process (Window.update() doesn't work properly)
var midiWndw = new Window("dialog", "MIDI Visualizer");
midiWndw.orientation = "column";
var midiConfigs = Array();
var midiCustomSettings = new MidiCustomSettings();

if (USE_MIDI_SETTINGS_FILE) {
    var xmlSettingsObj = readSettingsFile();
    if (xmlSettingsObj != false) {
        midiCustomSettings.readFromXml(xmlSettingsObj);
    }
}

// topContainer //

midiWndw.topContainer = midiWndw.add("group");
midiWndw.topContainer.orientation = "row";
midiWndw.topContainer.alignment = "fill";
//midiWndw.topContainer.alignChildren = "left";
midiWndw.topContainer.add("button", undefined, "Select Folder").onClick = function() {
    var selectedObject = Folder.selectDialog();
    if (selectedObject != null) {
        if (selectedObject instanceof Folder) {
            var midiFiles = selectedObject.getFiles("*.mid");
            if (midiFiles.length == 0) {
                Window.alert("No MIDI (.mid) files found in the specified directory.");
            } else {
                midiConfigs = [];
                midiWndw.midiContainer.midiListBox.removeAll();
                for (var i = 0; i < midiFiles.length; i++) {
                    var fileName = File.decode(midiFiles[i].name);
                    midiConfigs.push(new MidiConfig(midiFiles[i]));
                    midiWndw.midiContainer.midiListBox.add("item", midiConfigs[i].name + " (" + midiConfigs[i].fileName + ")" + " \/\/ Color: " + getColorNameOfIndex(midiConfigs[i].selectedColorIndex));
                }
                midiWndw.midiContainer.visible = true;
                midiWndw.midiContainer.midiListBox.selection = 0;
            }
        } else {
            Window.alert("Please select a folder, not a file!"); // Not sure if you can even select a file
        }
    }
};
midiWndw.topContainer.add("statictext", undefined, "Select a folder with MIDI files (.mid) inside.");

// midiContainer //

midiWndw.midiContainer = midiWndw.add("Panel", undefined, "Config");
midiWndw.midiContainer.preferredSize = [512, 512];
midiWndw.midiContainer.alignChildren = "left";
midiWndw.midiContainer.orientation = "column";
midiWndw.midiContainer.visible = false;

// midiListBox //

midiWndw.midiContainer.midiListBox = midiWndw.midiContainer.add("ListBox", [0, 0, 512, 196], undefined, {
    multiselect: true
});
midiWndw.midiContainer.midiListBox.alignChildren = "fill";
midiWndw.midiContainer.midiListBox.onChange = function onSelectionChanged() {
    handleSelectionUpdate();
}

midiWndw.midiContainer.add("statictext", [0, 0, 496, 48], "Select a MIDI file to change its properties.", {
    name: "selectionText",
    multiline: true
});

// configGroup //

midiWndw.midiContainer.configGroup = midiWndw.midiContainer.add("Panel", undefined, "Settings");
midiWndw.midiContainer.configGroup.visible = false;
midiWndw.midiContainer.configGroup.orientation = "column";
midiWndw.midiContainer.configGroup.alignChildren = "left";
midiWndw.midiContainer.configGroup.alignment = "fill";

var midiNameGroup = midiWndw.midiContainer.configGroup.add("group");
midiNameGroup.orientation = "row";
midiNameGroup.add("statictext", undefined, "Comp Name");
midiNameGroup.add("edittext", [0, 0, 256, 24], undefined, {
    name: "midiNameEditText"
});
midiWndw.findElement("midiNameEditText").onChanging = function onTextChanged() {
    var selection = getSelectedIndices();
    for (var i = 0; i < selection.length; i++) {
        midiConfigs[selection[i].index].name = this.text;
    }
    updateListBoxData();
};
var colorDropdownList = midiWndw.midiContainer.configGroup.add("DropdownList", [0, 0, 128, 24]);
for (var i = 0; i < midiCustomSettings.presetColors.length; i++) {
    colorDropdownList.add("Item", midiCustomSettings.presetColors[i].name);
}
colorDropdownList.onChange = function() {
    setColorForSelectedConfigs(this.selection.index);
};
midiWndw.halfSpeedCheckbox = midiWndw.midiContainer.configGroup.add("Checkbox", undefined, "Set to half speed");
midiWndw.halfSpeedCheckbox.helpTip = "This halves the speed of all events (notes etc.). This is a temporary solution for MIDI files that somehow are at double speed.";

midiWndw.midiContainer.progressGroup = midiWndw.midiContainer.add("group");
midiWndw.midiContainer.progressGroup.alignment = ["left", "bottom"];
midiWndw.midiContainer.progressGroup.orientation = "column";
midiWndw.midiContainer.progressGroup.alignChildren = "left";

midiWndw.pb = ProgressBar(midiWndw.midiContainer.progressGroup);

// footer //
midiWndw.footer = midiWndw.add("group");
midiWndw.footer.alignment = "fill";
midiWndw.footer.orientation = "row";


midiWndw.footer.margins = 0;
var creditsText = midiWndw.footer.add("statictext", undefined, "Tool created by PeaQew. Credits to omino for the MIDI File Reader.");
creditsText.alignment = ["left", "bottom"];

midiWndw.footer.rightGroup = midiWndw.footer.add("group");
midiWndw.footer.rightGroup.alignment = ["right", "bottom"];
midiWndw.footer.rightGroup.orientation = "column";

var versionText = midiWndw.footer.rightGroup.add("statictext", undefined, "v1.0.3");
versionText.alignment = "right";
versionText.helpTip = "Version 1.0.3, 2021-02-06";

midiWndw.footer.settingsBtn = midiWndw.footer.rightGroup.add("button", undefined, "Settings");
midiWndw.footer.settingsBtn.onClick = function() {
    showSettingsWindow();
}

midiWndw.footer.settingsBtn.alignment = "right";
midiWndw.center();
midiWndw.show();