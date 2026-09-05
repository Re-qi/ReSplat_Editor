import { writeFileSync } from 'node:fs';

const points = [];
for (const y of [-0.7, 0, 0.7]) {
    for (const x of [-0.7, 0, 0.7]) {
        points.push([x, y, 0, 0, 0, 0, 5, -1.4, -1.4, -1.4, 1, 0, 0, 0]);
    }
}

const header = `ply
format binary_little_endian 1.0
element vertex ${points.length}
property float x
property float y
property float z
property float f_dc_0
property float f_dc_1
property float f_dc_2
property float opacity
property float scale_0
property float scale_1
property float scale_2
property float rot_0
property float rot_1
property float rot_2
property float rot_3
end_header
`;
const body = Buffer.alloc(points.length * points[0].length * 4);
let offset = 0;
for (const point of points) {
    for (const value of point) {
        body.writeFloatLE(value, offset);
        offset += 4;
    }
}

writeFileSync(new URL('./fixtures/paint-pointer-repro.ply', import.meta.url), Buffer.concat([Buffer.from(header), body]));
