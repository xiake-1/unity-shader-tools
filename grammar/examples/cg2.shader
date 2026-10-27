Shader "A"
{
    Properties { _MainColor("MainColor",Color) = (1,1,1,1) }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #include "UnityCG.cginc"
            fixed4 _MainColor;
            struct v2f { float4 pos : SV_POSITION; };
            v2f vert (appdata_base v) { return v2f(); }
            ENDCG
        }
    }
}
