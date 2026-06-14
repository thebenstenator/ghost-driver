// Minimal stand-in for the parts of Phaser that the game's pure-logic modules
// (Vehicle, CopAI, CopCar, lineOfSight) actually touch. Lets the headless chase
// sim import those modules UNCHANGED — so the sim runs the real game math, not a
// reimplementation that could drift out of sync.
//
// Implementations mirror Phaser 3.90 exactly (RotateTo step semantics,
// LineToRectangle edge tests) so behaviour matches the browser build.

const PI2 = Math.PI * 2;

function Clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function Linear(p0, p1, t) {
  return (p1 - p0) * t + p0;
}

function Wrap(angle) {
  const a = (angle + Math.PI) % PI2;
  return (a >= 0 ? a : a + PI2) - Math.PI;
}

// Faithful port of Phaser.Math.Angle.RotateTo: `lerp` is an absolute radian step.
function RotateTo(currentAngle, targetAngle, lerp = 0.05) {
  if (currentAngle === targetAngle) return currentAngle;
  if (Math.abs(targetAngle - currentAngle) <= lerp ||
      Math.abs(targetAngle - currentAngle) >= (PI2 - lerp)) {
    currentAngle = targetAngle;
  } else {
    if (Math.abs(targetAngle - currentAngle) > Math.PI) {
      if (targetAngle < currentAngle) targetAngle += PI2;
      else targetAngle -= PI2;
    }
    if (targetAngle > currentAngle) currentAngle += lerp;
    else if (targetAngle < currentAngle) currentAngle -= lerp;
  }
  return currentAngle;
}

function RadToDeg(radians) {
  return radians * (180 / Math.PI);
}

function Between(x1, y1, x2, y2) {
  const dx = x1 - x2, dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

class Line {
  constructor(x1 = 0, y1 = 0, x2 = 0, y2 = 0) {
    this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2;
  }
  setTo(x1 = 0, y1 = 0, x2 = 0, y2 = 0) {
    this.x1 = x1; this.y1 = y1; this.x2 = x2; this.y2 = y2;
    return this;
  }
}

class Rectangle {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x; this.y = y; this.width = width; this.height = height;
  }
  get right()  { return this.x + this.width; }
  get bottom() { return this.y + this.height; }
}

// Faithful port of Phaser.Geom.Intersects.LineToRectangle.
function LineToRectangle(line, rect) {
  const x1 = line.x1, y1 = line.y1, x2 = line.x2, y2 = line.y2;
  const bx1 = rect.x, by1 = rect.y, bx2 = rect.right, by2 = rect.bottom;
  let t = 0;

  if ((x1 >= bx1 && x1 <= bx2 && y1 >= by1 && y1 <= by2) ||
      (x2 >= bx1 && x2 <= bx2 && y2 >= by1 && y2 <= by2)) {
    return true;
  }

  if (x1 < bx1 && x2 >= bx1) {
    t = y1 + (y2 - y1) * (bx1 - x1) / (x2 - x1);
    if (t > by1 && t <= by2) return true;
  } else if (x1 > bx2 && x2 <= bx2) {
    t = y1 + (y2 - y1) * (bx2 - x1) / (x2 - x1);
    if (t >= by1 && t <= by2) return true;
  }

  if (y1 < by1 && y2 >= by1) {
    t = x1 + (x2 - x1) * (by1 - y1) / (y2 - y1);
    if (t >= bx1 && t <= bx2) return true;
  } else if (y1 > by2 && y2 <= by2) {
    t = x1 + (x2 - x1) * (by2 - y1) / (y2 - y1);
    if (t >= bx1 && t <= bx2) return true;
  }

  return false;
}

const Phaser = {
  Math: {
    Clamp,
    Linear,
    RadToDeg,
    Distance: { Between },
    Angle: { Wrap, RotateTo },
  },
  Geom: {
    Line,
    Rectangle,
    Intersects: { LineToRectangle },
  },
};

export default Phaser;
