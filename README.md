# Municipal Services Application — Part 1 (Report Issues)

**Module:** Programming 3B (PROG7312) / Advanced Application Development (AAPD7112)
**Student:** Nosipho Xulu
**Student number:** ST10507346
**Institution:** IIE Rosebank College

---

## 1. Overview

A Windows Forms application that allows residents of a South African municipality to
report municipal issues. Part 1 implements the **Report Issues** function. The two
remaining functions, *Local Events and Announcements* and *Service Request Status*,
appear on the main menu but are disabled, as required by the specification.

The application implements **gamification** as its user engagement strategy. Residents
see a progress bar advance as they complete each part of a report, receive an
encouraging message naming the next step, and earn civic points on submission. The
running points total, report count and level are displayed on the main menu.

---

## 2. Requirements

| Requirement | Version |
|---|---|
| Operating system | Windows 10 or Windows 11 |
| IDE | Visual Studio 2019 or later, with the **.NET desktop development** workload |
| Framework | .NET Framework 4.8 |
| Language | C# 7.3 |

No external libraries, NuGet packages, database or internet connection are required.

---

## 3. How to compile

### Using Visual Studio (recommended)

1. Extract the folder anywhere on your machine.
2. Double-click **`ST10507346_PROG7312_Part1.sln`**, or open Visual Studio and choose
   **File > Open > Project/Solution** and select that file.
3. Build with **Build > Build Solution** or `Ctrl+Shift+B`.

The project is already configured: it targets .NET Framework 4.8, the root namespace is
`MunicipalServicesApp`, and all source files, references and the `App.config` are
included. No files need to be added manually and no NuGet packages are required.

If Visual Studio prompts to retarget the project because .NET Framework 4.8 is not
installed, install the **.NET Framework 4.8 targeting pack** through the Visual Studio
Installer (**Individual components > .NET Framework 4.8 SDK** and **targeting pack**)
rather than retargeting, since the specification requires .NET Framework.

### Using the command line

From a **Developer Command Prompt for Visual Studio**, in the folder containing the
`.sln` file:

```
msbuild ST10507346_PROG7312_Part1.sln /p:Configuration=Debug
```

## 4. How to run

- **From Visual Studio:** press `F5` (with debugging) or `Ctrl+F5` (without).
- **From the build output:** run
  `bin\Debug\ST10507346_PROG7312_Part1.exe`.

The **Municipal Services** main menu opens in the centre of the screen.

---

## 5. How to use the application

### Main menu

Three options are presented on startup:

1. **Report an Issue** — enabled.
2. **Local Events and Announcements** — disabled, released in a later version.
3. **Service Request Status** — disabled, released in a later version.

Below the options, a panel shows your **civic points**, the number of **reports** you
have submitted, and your current **level**. Hovering over a disabled option explains
why it cannot be selected yet.

### Reporting an issue

1. Click **Report an Issue**.
2. **Location** — type where the problem is, for example
   `12 Church Street, Sunnyside` or `corner of Main and 5th`.
3. **Category** — choose from the dropdown: Roads and Potholes, Water and Sanitation,
   Electricity and Street Lighting, Waste Removal, Stormwater and Drainage, Parks and
   Public Spaces, Public Safety, or Other.
4. **Description** — describe the issue. A minimum of 10 characters is required; a
   description of 30 characters or more earns additional civic points.
5. **Attach photo or document** — optional. Opens a file dialog filtered to images and
   documents. Files larger than 10 MB are rejected. The attached file name is shown
   next to the button.
6. Watch the **progress bar** fill as you complete each of the four parts. The message
   underneath tells you what to do next.
7. Click **Submit Report**. A confirmation appears showing your reference number
   (format `MSA-YYYY-NNNN`), the points earned and your new total.
8. **Clear Form** empties the form; **Back to Main Menu** returns to the menu and warns
   first if you have unsaved input.

### Civic points

| Action | Points |
|---|---|
| Submitting a valid report | 10 |
| Location of 5 characters or more | +5 |
| Description of 30 characters or more | +5 |
| Attaching a photo or document | +5 |
| **Maximum per report** | **25** |

| Level | Points required |
|---|---|
| Newcomer | 0 |
| Community Contributor | 1 |
| Active Citizen | 50 |
| Community Champion | 100 |

Points reward the *completeness of one report* rather than the number of reports
submitted. Rewarding volume would encourage duplicate or frivolous submissions;
rewarding completeness produces reports the municipality can act on.

---

## 6. Project structure

```
ST10507346_PROG7312_Part1.sln          Solution file - open this one
README.md
ST10507346_PROG7312_Part1/
├── ST10507346_PROG7312_Part1.csproj   Project file (.NET Framework 4.8)
├── App.config                         Runtime and DPI configuration
├── Models/
│   └── Issue.cs                       Represents one reported issue
├── Services/
│   └── IssueRepository.cs             List<Issue> store, points and level logic
├── Properties/
│   └── AssemblyInfo.cs                Assembly metadata
├── MainMenuForm.cs                    Main menu behaviour
├── MainMenuForm.Designer.cs           Main menu layout
├── ReportIssueForm.cs                 Report capture, validation, gamification
├── ReportIssueForm.Designer.cs        Report form layout
└── Program.cs                         Application entry point
```

## 7. Data structure used

Reported issues are stored in a **`List<Issue>`** held by the static
`IssueRepository` class.

A list was chosen because:

- Reports are added one at a time and the number of reports is not known in advance.
  A `List<T>` grows automatically; an array would have to be resized manually.
- Insertion order is preserved, which matters when the resident's report history is
  displayed in the order it was captured.
- `List<T>` gives O(1) amortised insertion at the end, which is the only write
  operation Part 1 performs.

The repository is static so that both forms read and write the same collection and the
same points total without passing references between them.

`IssueRepository.Categories` is also a `List<string>`, used as the single source of the
category values bound to the dropdown.

---

## 8. Event handling

| Control | Event | Handler |
|---|---|---|
| `btnReportIssues` | Click | Opens the Report Issue form, then refreshes the points panel |
| `btnExit` | Click | Confirms and closes the application |
| `txtLocation` | TextChanged | `InputChanged` — updates the progress bar |
| `cboCategory` | SelectedIndexChanged | `InputChanged` — updates the progress bar |
| `rtbDescription` | TextChanged | `InputChanged` — updates the progress bar |
| `btnAttach` | Click | Opens `OpenFileDialog` and records the attachment |
| `btnSubmit` | Click | Validates, stores the report, awards points |
| `btnClear` | Click | Confirms, then empties the form |
| `btnBack` | Click | Warns about unsaved input, then returns to the main menu |

---

## 9. Display scaling

Both forms use `AutoScaleMode.Font` and all controls are anchored, so the layout
adjusts when the window is resized or when Windows display scaling is set above 100%.

If the forms still appear blurred on a high-DPI display, add the following to
`App.config` inside the `<configuration>` element:

```xml
<System.Windows.Forms.ApplicationConfigurationSection>
  <add key="DpiAwareness" value="PerMonitorV2" />
</System.Windows.Forms.ApplicationConfigurationSection>
```

---

## 10. Troubleshooting

| Problem | Cause and fix |
|---|---|
| Visual Studio offers to retarget the project | The .NET Framework 4.8 targeting pack is not installed. Install it through the Visual Studio Installer instead of accepting the retarget. |
| `The .NET Framework version 'v4.8' is not installed` | Same cause as above. Install the 4.8 SDK and targeting pack. |
| The project loads but shows as unavailable | The **.NET desktop development** workload is missing from your Visual Studio installation. |
| The forms do not open in the designer | Ensure each `.Designer.cs` file is nested under its matching `.cs` file, and that both declare `partial class` in the same namespace. |
| Points reset when the application closes | Expected in Part 1. Storage is in memory only; persistence is not required by this part of the specification. |

---

## 11. Known limitations

- Data is held in memory and is lost when the application closes.
- Attachments are recorded by file path; the files themselves are not copied.
- The two remaining menu options are intentionally disabled until Part 2 and Part 3.
